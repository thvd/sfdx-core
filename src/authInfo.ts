/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { createHash, randomBytes } from 'crypto';
import { resolve as pathResolve } from 'path';
import { basename, extname } from 'path';
import * as os from 'os';
import { AsyncCreatable, cloneJson, env, isEmpty, parseJson, parseJsonMap, set } from '@salesforce/kit';
import {
  AnyFunction,
  AnyJson,
  asString,
  ensure,
  ensureJsonMap,
  ensureString,
  getString,
  isArray,
  isPlainObject,
  isString,
  JsonMap,
  keysOf,
  Nullable,
  Optional,
} from '@salesforce/ts-types';
import { OAuth2, OAuth2Options, TokenResponse } from 'jsforce';
// No typings directly available for jsforce/lib/transport
// @ts-ignore
import * as Transport from 'jsforce/lib/transport';
import * as jwt from 'jsonwebtoken';
import { Aliases } from './config/aliases';
import { AuthInfoConfig } from './config/authInfoConfig';
import { Config } from './config/config';
import { ConfigAggregator } from './config/configAggregator';
import { Connection, SFDX_HTTP_HEADERS } from './connection';
import { Crypto } from './crypto';
import { Global } from './global';
import { Logger } from './logger';
import { SfdxError, SfdxErrorConfig } from './sfdxError';
import { fs } from './util/fs';
import { sfdc } from './util/sfdc';
import { SfdcUrl } from './util/sfdcUrl';

/**
 * Fields for authorization, org, and local information.
 */
// Fields that are persisted in auth files
export interface AuthFields {
  accessToken?: string;
  alias?: string;
  authCode?: string;
  clientId?: string;
  clientSecret?: string;
  created?: string;
  createdOrgInstance?: string;
  devHubUsername?: string;
  instanceUrl?: string;
  instanceApiVersion?: string;
  instanceApiVersionLastRetrieved?: string;
  isDevHub?: boolean;
  loginUrl?: string;
  orgId?: string;
  password?: string;
  privateKey?: string;
  refreshToken?: string;
  scratchAdminUsername?: string;
  snapshot?: string;
  userId?: string;
  username?: string;
  usernames?: string[];
  userProfileName?: string;
  expirationDate?: string;
}

export type Authorization = {
  alias: Optional<string>;
  username: Optional<string>;
  orgId: Optional<string>;
  instanceUrl: Optional<string>;
  accessToken?: string;
  oauthMethod?: 'jwt' | 'web' | 'token' | 'unknown';
  error?: string;
};

/**
 * Options for access token flow.
 */
export interface AccessTokenOptions {
  accessToken?: string;
  loginUrl?: string;
  instanceUrl?: string;
}

type UserInfo = AnyJson & {
  username: string;
  organizationId: string;
};

/* eslint-disable camelcase */
type UserInfoResult = AnyJson & {
  preferred_username: string;
  organization_id: string;
  user_id: string;
};
/* eslint-enable camelcase */

type User = AnyJson & {
  Username: string;
};

/**
 * A function to update a refresh token when the access token is expired.
 */
export type RefreshFn = (
  conn: Connection,
  callback: (err: Nullable<Error>, accessToken?: string, res?: Record<string, unknown>) => Promise<void>
) => Promise<void>;

/**
 * Options for {@link Connection}.
 */
export type ConnectionOptions = AuthFields & {
  /**
   * OAuth options.
   */
  oauth2?: Partial<OAuth2Options>;
  /**
   * Refresh token callback.
   */
  refreshFn?: RefreshFn;
};

// Extend OAuth2 to add JWT Bearer Token Flow support.
class JwtOAuth2 extends OAuth2 {
  public constructor(options: OAuth2Options) {
    super(options);
  }

  public jwtAuthorize(innerToken: string, callback?: AnyFunction): Promise<AnyJson> {
    // @ts-ignore
    return super._postParams(
      {
        // eslint-disable-next-line camelcase
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: innerToken,
      },
      callback
    );
  }
}

/**
 * Extend OAuth2 to add code verifier support for the auth code (web auth) flow
 * const oauth2 = new OAuth2WithVerifier({ loginUrl, clientSecret, clientId, redirectUri });
 *
 * const authUrl = oauth2.getAuthorizationUrl({
 *    state: 'foo',
 *    prompt: 'login',
 *    scope: 'api web'
 * });
 * console.log(authUrl);
 * const authCode = await retrieveCode();
 * const authInfo = await AuthInfo.create({ oauth2Options: { clientId, clientSecret, loginUrl, authCode }, oauth2});
 * console.log(`access token: ${authInfo.getFields().accessToken}`);
 */
export class OAuth2WithVerifier extends OAuth2 {
  public readonly codeVerifier: string;

  public constructor(options: OAuth2Options) {
    super(options);

    // Set a code verifier string for OAuth authorization
    this.codeVerifier = base64UrlEscape(randomBytes(Math.ceil(128)).toString('base64'));
  }

  /**
   * Overrides jsforce.OAuth2.getAuthorizationUrl.  Get Salesforce OAuth2 authorization page
   * URL to redirect user agent, adding a verification code for added security.
   *
   * @param params
   */
  public getAuthorizationUrl(params: Record<string, unknown>): string {
    // code verifier must be a base 64 url encoded hash of 128 bytes of random data. Our random data is also
    // base 64 url encoded. See Connection.create();
    const codeChallenge = base64UrlEscape(createHash('sha256').update(this.codeVerifier).digest('base64'));
    set(params, 'code_challenge', codeChallenge);

    return super.getAuthorizationUrl(params);
  }

  public async requestToken(
    code: string,
    callback?: (err: Error, tokenResponse: TokenResponse) => void
  ): Promise<TokenResponse> {
    return super.requestToken(code, callback);
  }

  /**
   * Overrides jsforce.OAuth2._postParams because jsforce's oauth impl doesn't support
   * coder_verifier and code_challenge. This enables the server to disallow trading a one-time auth code
   * for an access/refresh token when the verifier and challenge are out of alignment.
   *
   * See https://github.com/jsforce/jsforce/issues/665
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async _postParams(params: Record<string, unknown>, callback: AnyFunction): Promise<any> {
    set(params, 'code_verifier', this.codeVerifier);
    // @ts-ignore TODO: need better typings for jsforce
    return super._postParams(params, callback);
  }
}

// parses the id field returned from jsForce oauth2 methods to get
// user ID and org ID.
function parseIdUrl(idUrl: string) {
  const idUrls = idUrl.split('/');
  const userId = idUrls.pop();
  const orgId = idUrls.pop();

  return {
    userId,
    orgId,
    url: idUrl,
  };
}

export const DEFAULT_CONNECTED_APP_INFO = {
  clientId: 'PlatformCLI',
  // Legacy. The connected app info is owned by the thing that
  // creates new AuthInfos. Currently that is the auth:* commands which
  // aren't owned by this core library. These values need to be here
  // for any old auth files where the id and secret aren't stored.
  //
  // Ideally, this would be removed at some point in the distant future
  // when all auth files now have the clientId stored in it.
  legacyClientId: 'SalesforceDevelopmentExperience',
  legacyClientSecret: '1384510088588713504',
};

class AuthInfoCrypto extends Crypto {
  private static readonly encryptedFields: Array<keyof AuthFields> = [
    'accessToken',
    'refreshToken',
    'password',
    'clientSecret',
  ];

  public decryptFields(fields: AuthFields): AuthFields {
    return this.crypt(fields, 'decrypt');
  }

  public encryptFields(fields: AuthFields): AuthFields {
    return this.crypt(fields, 'encrypt');
  }

  private crypt(fields: AuthFields, method: 'encrypt' | 'decrypt'): AuthFields {
    const copy: AuthFields = {};
    for (const key of keysOf(fields)) {
      const rawValue = fields[key];
      if (rawValue !== undefined) {
        if (isString(rawValue) && AuthInfoCrypto.encryptedFields.includes(key)) {
          copy[key] = this[method](asString(rawValue)) as never;
        } else {
          copy[key] = rawValue as never;
        }
      }
    }
    return copy;
  }
}

// Makes a nodejs base64 encoded string compatible with rfc4648 alternative encoding for urls.
// @param base64Encoded a nodejs base64 encoded string
function base64UrlEscape(base64Encoded: string): string {
  // builtin node js base 64 encoding is not 64 url compatible.
  // See https://toolsn.ietf.org/html/rfc4648#section-5
  return base64Encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Handles persistence and fetching of user authentication information using
 * JWT, OAuth, or refresh tokens. Sets up the refresh flows that jsForce will
 * use to keep tokens active. An AuthInfo can also be created with an access
 * token, but AuthInfos created with access tokens can't be persisted to disk.
 *
 * **See** [Authorization](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_auth.htm)
 *
 * **See** [Salesforce DX Usernames and Orgs](https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_cli_usernames_orgs.htm)
 *
 * ```
 * // Creating a new authentication file.
 * const authInfo = await AuthInfo.create({
 *   username: myAdminUsername,
 *   oauth2Options: {
 *     loginUrl, authCode, clientId, clientSecret
 *   }
 * );
 * authInfo.save();
 *
 * // Creating an authorization info with an access token.
 * const authInfo = await AuthInfo.create({
 *   username: accessToken
 * });
 *
 * // Using an existing authentication file.
 * const authInfo = await AuthInfo.create({
 *   username: myAdminUsername
 * });
 *
 * // Using the AuthInfo
 * const connection = await Connection.create({ authInfo });
 * ```
 */
export class AuthInfo extends AsyncCreatable<AuthInfo.Options> {
  // The regular expression that filters files stored in $HOME/.sfdx
  private static authFilenameFilterRegEx = /^[^.][^@]*@[^.]+(\.[^.\s]+)+\.json$/;

  // Cache of auth fields by username.
  private static cache: Map<string, AuthFields> = new Map();

  // All sensitive fields are encrypted
  private fields: AuthFields = {};

  // Possibly overridden in create
  private usingAccessToken = false;

  // Initialized in init
  private logger!: Logger;

  private authInfoCrypto!: AuthInfoCrypto;

  private options: AuthInfo.Options;

  /**
   * Constructor
   * **Do not directly construct instances of this class -- use {@link AuthInfo.create} instead.**
   *
   * @param options The options for the class instance
   */
  public constructor(options: AuthInfo.Options) {
    super(options);
    this.options = options;
  }

  /**
   * Returns the default instance url
   *
   * @returns {string}
   */
  public static getDefaultInstanceUrl(): string {
    const configuredInstanceUrl = ConfigAggregator.getValue('instanceUrl').value as string;
    return configuredInstanceUrl || SfdcUrl.PRODUCTION;
  }

  /**
   * Get a list of all auth files stored in the global directory.
   *
   * @returns {Promise<string[]>}
   *
   * @deprecated Removed in v3 {@link https://github.com/forcedotcom/sfdx-core/blob/v3/MIGRATING_V2-V3.md#globalinfo}
   */
  public static async listAllAuthFiles(): Promise<string[]> {
    const globalFiles = await fs.readdir(Global.DIR);
    const authFiles = globalFiles.filter((file) => file.match(AuthInfo.authFilenameFilterRegEx));

    // Want to throw a clean error if no files are found.
    if (isEmpty(authFiles)) {
      const errConfig: SfdxErrorConfig = new SfdxErrorConfig('@salesforce/core', 'core', 'NoAuthInfoFound');
      throw SfdxError.create(errConfig);
    }

    // At least one auth file is in the global dir.
    return authFiles;
  }

  /**
   * Get a list of all authorizations based on auth files stored in the global directory.
   *
   * @returns {Promise<Authorization[]>}
   */
  public static async listAllAuthorizations(): Promise<Authorization[]> {
    const filenames = await AuthInfo.listAllAuthFiles();

    const auths: Authorization[] = [];
    const aliases = await Aliases.create(Aliases.getDefaultOptions());

    for (const filename of filenames) {
      const username = basename(filename, extname(filename));
      try {
        const config = await AuthInfo.create({ username });
        const fields = config.getFields();
        const usernameAliases = aliases.getKeysByValue(username);
        auths.push({
          alias: usernameAliases[0],
          username: fields.username,
          orgId: fields.orgId,
          instanceUrl: fields.instanceUrl,
          accessToken: config.getConnectionOptions().accessToken,
          oauthMethod: config.isJwt() ? 'jwt' : config.isOauth() ? 'web' : 'token',
        });
      } catch (err) {
        // Most likely, an error decrypting the token
        const file = await AuthInfoConfig.create(AuthInfoConfig.getOptions(username));
        const contents = file.getContents();
        const usernameAliases = aliases.getKeysByValue(contents.username as string);
        auths.push({
          alias: usernameAliases[0],
          username: contents.username as string,
          orgId: contents.orgId as string,
          instanceUrl: contents.instanceUrl as string,
          accessToken: undefined,
          oauthMethod: 'unknown',
          error: err.message,
        });
      }
    }
    return auths;
  }

  /**
   * Returns true if one or more authentications are persisted.
   */
  public static async hasAuthentications(): Promise<boolean> {
    try {
      const authFiles: string[] = await this.listAllAuthFiles();
      return !isEmpty(authFiles);
    } catch (err) {
      if (err.name === 'OrgDataNotAvailableError' || err.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Get the authorization URL.
   *
   * @param options The options to generate the URL.
   */
  public static getAuthorizationUrl(options: OAuth2Options & { scope?: string }, oauth2?: OAuth2WithVerifier): string {
    const oauth2Verifier = oauth2 || new OAuth2WithVerifier(options);

    // The state parameter allows the redirectUri callback listener to ignore request
    // that don't contain the state value.
    const params = {
      state: randomBytes(Math.ceil(6)).toString('hex'),
      prompt: 'login',
      // Default connected app is 'refresh_token api web'
      scope: options.scope || env.getString('SFDX_AUTH_SCOPES', 'refresh_token api web'),
    };

    return oauth2Verifier.getAuthorizationUrl(params);
  }

  /**
   * Forces the auth file to be re-read from disk for a given user. Returns `true` if a value was removed.
   *
   * @param username The username for the auth info to re-read.
   *
   * @deprecated Removed in v3 {@link https://github.com/forcedotcom/sfdx-core/blob/v3/MIGRATING_V2-V3.md#configstore-configfile-authinfo-and-encrypting-values}
   */
  public static clearCache(username: string): boolean {
    if (username) {
      return AuthInfo.cache.delete(username);
    }
    return false;
  }

  /**
   * Parse a sfdx auth url, usually obtained by `authInfo.getSfdxAuthUrl`.
   *
   * @example
   * ```
   * await AuthInfo.create(AuthInfo.parseSfdxAuthUrl(sfdxAuthUrl));
   * ```
   * @param sfdxAuthUrl
   */
  public static parseSfdxAuthUrl(
    sfdxAuthUrl: string
  ): Pick<AuthFields, 'clientId' | 'clientSecret' | 'refreshToken' | 'loginUrl'> {
    const match = sfdxAuthUrl.match(
      /^force:\/\/([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]*):([a-zA-Z0-9._-]+={0,2})@([a-zA-Z0-9._-]+)/
    );

    if (!match) {
      throw new SfdxError(
        'Invalid SFDX auth URL. Must be in the format "force://<clientId>:<clientSecret>:<refreshToken>@<instanceUrl>".  Note that the SFDX auth URL uses the "force" protocol, and not "http" or "https".  Also note that the "instanceUrl" inside the SFDX auth URL doesn\'t include the protocol ("https://").',
        'INVALID_SFDX_AUTH_URL'
      );
    }
    const [, clientId, clientSecret, refreshToken, loginUrl] = match;
    return {
      clientId,
      clientSecret,
      refreshToken,
      loginUrl: `https://${loginUrl}`,
    };
  }

  /**
   * Get the username.
   */
  public getUsername(): Optional<string> {
    return this.fields.username;
  }

  /**
   * Returns true if `this` is using the JWT flow.
   */
  public isJwt(): boolean {
    const { refreshToken, privateKey } = this.fields;
    return !refreshToken && !!privateKey;
  }

  /**
   * Returns true if `this` is using an access token flow.
   */
  public isAccessTokenFlow(): boolean {
    const { refreshToken, privateKey } = this.fields;
    return !refreshToken && !privateKey;
  }

  /**
   * Returns true if `this` is using the oauth flow.
   */
  public isOauth(): boolean {
    return !this.isAccessTokenFlow() && !this.isJwt();
  }

  /**
   * Returns true if `this` is using the refresh token flow.
   */
  public isRefreshTokenFlow(): boolean {
    const { refreshToken, authCode } = this.fields;
    return !authCode && !!refreshToken;
  }

  /**
   * Updates the cache and persists the authentication fields (encrypted).
   *
   * @param authData New data to save.
   */
  public async save(authData?: AuthFields): Promise<AuthInfo> {
    this.update(authData);
    const username = ensure(this.getUsername());

    if (sfdc.matchesAccessToken(username)) {
      this.logger.debug('Username is an accesstoken. Skip saving authinfo to disk.');
      return this;
    }

    AuthInfo.cache.set(username, this.fields);

    const dataToSave = cloneJson(this.fields);

    this.logger.debug(dataToSave);

    const config = await AuthInfoConfig.create({
      ...AuthInfoConfig.getOptions(username),
      throwOnNotFound: false,
    });
    config.setContentsFromObject(dataToSave);
    await config.write();

    this.logger.info(`Saved auth info for username: ${this.getUsername()}`);
    return this;
  }

  /**
   * Update the authorization fields, encrypting sensitive fields, but do not persist.
   * For convenience `this` object is returned.
   *
   * @param authData Authorization fields to update.
   * @param encrypt Encrypt the fields.
   */
  public update(authData?: AuthFields, encrypt = true): AuthInfo {
    if (authData && isPlainObject(authData)) {
      let copy = cloneJson(authData);
      if (encrypt) {
        copy = this.authInfoCrypto.encryptFields(copy);
      }
      Object.assign(this.fields, copy);
      this.logger.info(`Updated auth info for username: ${this.getUsername()}`);
    }
    return this;
  }

  /**
   * Get the auth fields (decrypted) needed to make a connection.
   */
  public getConnectionOptions(): ConnectionOptions {
    let opts: ConnectionOptions;

    const { accessToken, instanceUrl, loginUrl } = this.fields;

    if (this.isAccessTokenFlow()) {
      this.logger.info('Returning fields for a connection using access token.');

      // Just auth with the accessToken
      opts = { accessToken, instanceUrl, loginUrl };
    } else if (this.isJwt()) {
      this.logger.info('Returning fields for a connection using JWT config.');
      opts = {
        accessToken,
        instanceUrl,
        refreshFn: this.refreshFn.bind(this),
      };
    } else {
      // @TODO: figure out loginUrl and redirectUri (probably get from config class)
      //
      // redirectUri: org.config.getOauthCallbackUrl()
      // loginUrl: this.fields.instanceUrl || this.config.getAppConfig().sfdcLoginUrl
      this.logger.info('Returning fields for a connection using OAuth config.');

      // Decrypt a user provided client secret or use the default.
      opts = {
        oauth2: {
          loginUrl: instanceUrl || SfdcUrl.PRODUCTION,
          clientId: this.fields.clientId || DEFAULT_CONNECTED_APP_INFO.legacyClientId,
          redirectUri: 'http://localhost:1717/OauthRedirect',
        },
        accessToken,
        instanceUrl,
        refreshFn: this.refreshFn.bind(this),
      };
    }

    // decrypt the fields
    return this.authInfoCrypto.decryptFields(opts);
  }

  /**
   * Get the authorization fields.
   *
   * @param decrypt Decrypt the fields.
   */
  public getFields(decrypt?: boolean): AuthFields {
    return decrypt ? this.authInfoCrypto.decryptFields(this.fields) : this.fields;
  }

  /**
   * Get the org front door (used for web based oauth flows)
   */
  public getOrgFrontDoorUrl(): string {
    const authFields = this.getFields();
    const base = ensureString(authFields.instanceUrl).replace(/\/+$/, '');
    const accessToken = ensureString(authFields.accessToken);
    return `${base}/secur/frontdoor.jsp?sid=${accessToken}`;
  }

  /**
   * Returns true if this org is using access token auth.
   */
  public isUsingAccessToken(): boolean {
    return this.usingAccessToken;
  }

  /**
   * Get the SFDX Auth URL.
   *
   * **See** [SFDX Authorization](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_force_auth.htm#cli_reference_force_auth)
   */
  public getSfdxAuthUrl(): string {
    const decryptedFields = this.authInfoCrypto.decryptFields(this.fields);
    const instanceUrl = ensure(decryptedFields.instanceUrl, 'undefined instanceUrl').replace(/^https?:\/\//, '');
    let sfdxAuthUrl = 'force://';

    if (decryptedFields.clientId) {
      sfdxAuthUrl += `${decryptedFields.clientId}:${decryptedFields.clientSecret || ''}:`;
    }

    sfdxAuthUrl += `${ensure(decryptedFields.refreshToken, 'undefined refreshToken')}@${instanceUrl}`;
    return sfdxAuthUrl;
  }

  /**
   * Set the defaultusername or the defaultdevhubusername to the alias if
   * it exists otherwise to the username. Method will try to set the local
   * config first but will default to global config if that fails.
   *
   * @param options
   */
  public async setAsDefault(options: { defaultUsername?: boolean; defaultDevhubUsername?: boolean }): Promise<void> {
    let config: Config;
    // if we fail to create the local config, default to the global config
    try {
      config = await Config.create({ isGlobal: false });
    } catch {
      config = await Config.create({ isGlobal: true });
    }

    const username = ensureString(this.getUsername());
    const aliases = await Aliases.create(Aliases.getDefaultOptions());
    const value = aliases.getKeysByValue(username)[0] || username;

    if (options.defaultUsername) {
      config.set(Config.DEFAULT_USERNAME, value);
    }

    if (options.defaultDevhubUsername) {
      config.set(Config.DEFAULT_DEV_HUB_USERNAME, value);
    }
    await config.write();
  }

  /**
   * Sets the provided alias to the username
   *
   * @param alias alias to set
   */
  public async setAlias(alias: string): Promise<void> {
    const username = this.getUsername();
    await Aliases.parseAndUpdate([`${alias}=${username}`]);
  }

  /**
   * Initializes an instance of the AuthInfo class.
   */
  public async init(): Promise<void> {
    // Must specify either username and/or options
    const options = this.options.oauth2Options || this.options.accessTokenOptions;
    if (!this.options.username && !(this.options.oauth2Options || this.options.accessTokenOptions)) {
      throw SfdxError.create('@salesforce/core', 'core', 'AuthInfoCreationError');
    }

    // If a username AND oauth options were passed, ensure an auth file for the username doesn't
    // already exist.  Throw if it does so we don't overwrite the auth file.
    if (this.options.username && this.options.oauth2Options) {
      const authInfoConfig = await AuthInfoConfig.create({
        ...AuthInfoConfig.getOptions(this.options.username),
        throwOnNotFound: false,
      });
      if (await authInfoConfig.exists()) {
        throw SfdxError.create(
          new SfdxErrorConfig(
            '@salesforce/core',
            'core',
            'AuthInfoOverwriteError',
            undefined,
            'AuthInfoOverwriteErrorAction'
          )
        );
      }
    }

    this.fields.username = this.options.username || getString(options, 'username') || undefined;

    // If the username is an access token, use that for auth and don't persist
    if (isString(this.fields.username) && sfdc.matchesAccessToken(this.fields.username)) {
      // Need to initAuthOptions the logger and authInfoCrypto since we don't call init()
      this.logger = await Logger.child('AuthInfo');
      this.authInfoCrypto = await AuthInfoCrypto.create({
        noResetOnClose: true,
      });

      const aggregator: ConfigAggregator = await ConfigAggregator.create();
      const instanceUrl: string = this.getInstanceUrl(options, aggregator);

      this.update({
        accessToken: this.options.username,
        instanceUrl,
        loginUrl: instanceUrl,
        orgId: this.fields.username.split('!')[0],
      });

      this.usingAccessToken = true;
    } else {
      await this.initAuthOptions(options);
    }
  }

  private getInstanceUrl(options: unknown, aggregator: ConfigAggregator) {
    const instanceUrl = getString(options, 'instanceUrl') || (aggregator.getPropertyValue('instanceUrl') as string);
    return instanceUrl || SfdcUrl.PRODUCTION;
  }

  /**
   * Initialize this AuthInfo instance with the specified options. If options are not provided, initialize it from cache
   * or by reading from the persistence store. For convenience `this` object is returned.
   *
   * @param options Options to be used for creating an OAuth2 instance.
   *
   * **Throws** *{@link SfdxError}{ name: 'NamedOrgNotFound' }* Org information does not exist.
   * @returns {Promise<AuthInfo>}
   */
  private async initAuthOptions(options?: OAuth2Options | AccessTokenOptions): Promise<AuthInfo> {
    this.logger = await Logger.child('AuthInfo');
    this.authInfoCrypto = await AuthInfoCrypto.create();

    // If options were passed, use those before checking cache and reading an auth file.
    let authConfig: AuthFields;

    if (options) {
      options = cloneJson(options);

      if (this.isTokenOptions(options)) {
        authConfig = options;
        const userInfo = await this.retrieveUserInfo(
          ensureString(options.instanceUrl),
          ensureString(options.accessToken)
        );
        this.fields.username = userInfo?.username;
        this.fields.orgId = userInfo?.organizationId;
      } else {
        if (this.options.parentUsername) {
          const parentUserFields = await this.loadAuthFromConfig(this.options.parentUsername);
          const parentFields = this.authInfoCrypto.decryptFields(parentUserFields);

          options.clientId = parentFields.clientId;

          if (process.env.SFDX_CLIENT_SECRET) {
            options.clientSecret = process.env.SFDX_CLIENT_SECRET;
          } else {
            // Grab whatever flow is defined
            Object.assign(options, {
              clientSecret: parentFields.clientSecret,
              privateKey: parentFields.privateKey ? pathResolve(parentFields.privateKey) : parentFields.privateKey,
            });
          }
        }

        // jwt flow
        // Support both sfdx and jsforce private key values
        if (!options.privateKey && options.privateKeyFile) {
          options.privateKey = pathResolve(options.privateKeyFile);
        }

        if (options.privateKey) {
          authConfig = await this.buildJwtConfig(options);
        } else if (!options.authCode && options.refreshToken) {
          // refresh token flow (from sfdxUrl or OAuth refreshFn)
          authConfig = await this.buildRefreshTokenConfig(options);
        } else {
          if (this.options.oauth2 instanceof OAuth2WithVerifier) {
            // authcode exchange / web auth flow
            authConfig = await this.exchangeToken(options, this.options.oauth2);
          } else {
            authConfig = await this.exchangeToken(options);
          }
        }
      }

      // Update the auth fields WITH encryption
      this.update(authConfig);
    } else {
      authConfig = await this.loadAuthFromConfig(ensure(this.getUsername()));
      // Update the auth fields WITHOUT encryption (already encrypted)
      this.update(authConfig, false);
    }

    const username = this.getUsername();
    if (username) {
      // Cache the fields by username (fields are encrypted)
      AuthInfo.cache.set(username, this.fields);
    }

    return this;
  }

  private async loadAuthFromConfig(username: string): Promise<AuthFields> {
    if (AuthInfo.cache.has(username)) {
      return ensure(AuthInfo.cache.get(username));
    } else {
      // Fetch from the persisted auth file
      try {
        const config: AuthInfoConfig = await AuthInfoConfig.create({
          ...AuthInfoConfig.getOptions(username),
          throwOnNotFound: true,
        });
        return config.toObject();
      } catch (e) {
        if (e.code === 'ENOENT') {
          throw SfdxError.create('@salesforce/core', 'core', 'NamedOrgNotFound', [
            this.options.isDevHub ? 'devhub username' : 'username',
            username,
          ]);
        } else {
          throw e;
        }
      }
    }
  }

  private isTokenOptions(options: OAuth2Options | AccessTokenOptions): options is AccessTokenOptions {
    // Although OAuth2Options does not contain refreshToken, privateKey, or privateKeyFile, a JS consumer could still pass those in
    // which WILL have an access token as well, but it should be considered an OAuth2Options at that point.
    return (
      'accessToken' in options &&
      !('refreshToken' in options) &&
      !('privateKey' in options) &&
      !('privateKeyFile' in options) &&
      !('authCode' in options)
    );
  }

  // A callback function for a connection to refresh an access token.  This is used
  // both for a JWT connection and an OAuth connection.
  private async refreshFn(
    conn: Connection,
    callback: (err: Nullable<Error | SfdxError>, accessToken?: string, res?: Record<string, unknown>) => Promise<void>
  ): Promise<void> {
    this.logger.info('Access token has expired. Updating...');

    try {
      const fields = this.authInfoCrypto.decryptFields(this.fields);
      await this.initAuthOptions(fields);
      await this.save();
      return await callback(null, fields.accessToken);
    } catch (err) {
      if (err.message && err.message.includes('Data Not Available')) {
        const errConfig = new SfdxErrorConfig('@salesforce/core', 'core', 'OrgDataNotAvailableError', [
          this.getUsername(),
        ]);
        for (let i = 1; i < 5; i++) {
          errConfig.addAction(`OrgDataNotAvailableErrorAction${i}`);
        }
        return await callback(SfdxError.create(errConfig));
      }
      return await callback(err);
    }
  }

  // Build OAuth config for a JWT auth flow
  private async buildJwtConfig(options: OAuth2Options): Promise<AuthFields> {
    const privateKeyContents = await fs.readFile(ensure(options.privateKey), 'utf8');
    const { loginUrl = SfdcUrl.PRODUCTION } = options;
    const url = new SfdcUrl(loginUrl);
    const createdOrgInstance = getString(options, 'createdOrgInstance', '').trim().toLowerCase();
    const audienceUrl = await url.getJwtAudienceUrl(createdOrgInstance);
    const jwtToken = jwt.sign(
      {
        iss: options.clientId,
        sub: this.getUsername(),
        aud: audienceUrl,
        exp: Date.now() + 300,
      },
      privateKeyContents,
      {
        algorithm: 'RS256',
      }
    );

    const oauth2 = new JwtOAuth2({ loginUrl: options.loginUrl });
    let authFieldsBuilder: JsonMap;
    try {
      authFieldsBuilder = ensureJsonMap(await oauth2.jwtAuthorize(jwtToken));
    } catch (err) {
      throw SfdxError.create('@salesforce/core', 'core', 'JWTAuthError', [err.message]);
    }

    const authFields: AuthFields = {
      accessToken: asString(authFieldsBuilder.access_token),
      orgId: parseIdUrl(ensureString(authFieldsBuilder.id)).orgId,
      loginUrl: options.loginUrl,
      privateKey: options.privateKey,
      clientId: options.clientId,
    };

    const instanceUrl = ensureString(authFieldsBuilder.instance_url);
    const sfdcUrl = new SfdcUrl(instanceUrl);
    try {
      // Check if the url is resolvable. This can fail when my-domains have not been replicated.
      await sfdcUrl.lookup();
      authFields.instanceUrl = instanceUrl;
    } catch (err) {
      this.logger.debug(
        `Instance URL [${authFieldsBuilder.instance_url}] is not available.  DNS lookup failed. Using loginUrl [${options.loginUrl}] instead. This may result in a "Destination URL not reset" error.`
      );
      authFields.instanceUrl = options.loginUrl;
    }

    return authFields;
  }

  // Build OAuth config for a refresh token auth flow
  private async buildRefreshTokenConfig(options: OAuth2Options): Promise<AuthFields> {
    // Ideally, this would be removed at some point in the distant future when all auth files
    // now have the clientId stored in it.
    if (!options.clientId) {
      options.clientId = DEFAULT_CONNECTED_APP_INFO.legacyClientId;
      options.clientSecret = DEFAULT_CONNECTED_APP_INFO.legacyClientSecret;
    }

    const oauth2 = new OAuth2(options);
    let authFieldsBuilder: TokenResponse;
    try {
      authFieldsBuilder = await oauth2.refreshToken(ensure(options.refreshToken));
    } catch (err) {
      throw SfdxError.create('@salesforce/core', 'core', 'RefreshTokenAuthError', [err.message]);
    }

    // @ts-ignore
    const { orgId } = parseIdUrl(authFieldsBuilder.id);

    let username = this.getUsername();
    if (!username) {
      // @ts-ignore
      const userInfo = await this.retrieveUserInfo(authFieldsBuilder.instance_url, authFieldsBuilder.access_token);
      username = userInfo?.username;
    }
    return {
      orgId,
      username,
      accessToken: authFieldsBuilder.access_token,
      // @ts-ignore TODO: need better typings for jsforce
      instanceUrl: authFieldsBuilder.instance_url,
      // @ts-ignore TODO: need better typings for jsforce
      loginUrl: options.loginUrl || authFieldsBuilder.instance_url,
      refreshToken: options.refreshToken,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    };
  }

  /**
   * Performs an authCode exchange but the Oauth2 feature of jsforce is extended to include a code_challenge
   *
   * @param options The oauth options
   * @param oauth2 The oauth2 extension that includes a code_challenge
   */
  private async exchangeToken(options: OAuth2Options, oauth2: OAuth2 = new OAuth2(options)): Promise<AuthFields> {
    // Exchange the auth code for an access token and refresh token.
    let authFields: TokenResponse;
    try {
      this.logger.info(`Exchanging auth code for access token using loginUrl: ${options.loginUrl}`);
      authFields = await oauth2.requestToken(ensure(options.authCode));
    } catch (err) {
      throw SfdxError.create('@salesforce/core', 'core', 'AuthCodeExchangeError', [err.message]);
    }

    // @ts-ignore TODO: need better typings for jsforce
    const { orgId } = parseIdUrl(authFields.id);

    let username: Optional<string> = this.getUsername();

    // Only need to query for the username if it isn't known. For example, a new auth code exchange
    // rather than refreshing a token on an existing connection.
    if (!username) {
      // @ts-ignore
      const userInfo = await this.retrieveUserInfo(authFields.instance_url, authFields.access_token);
      username = userInfo?.username;
    }

    return {
      accessToken: authFields.access_token,
      // @ts-ignore TODO: need better typings for jsforce
      instanceUrl: authFields.instance_url,
      orgId,
      username,
      // @ts-ignore TODO: need better typings for jsforce
      loginUrl: options.loginUrl || authFields.instance_url,
      refreshToken: authFields.refresh_token,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    };
  }

  private async retrieveUserInfo(instanceUrl: string, accessToken: string): Promise<Optional<UserInfo>> {
    // Make a REST call for the username directly.  Normally this is done via a connection
    // but we don't want to create circular dependencies or lots of snowflakes
    // within this file to support it.
    const apiVersion = 'v51.0'; // hardcoding to v51.0 just for this call is okay.
    const instance = ensure(instanceUrl);
    const baseUrl = new SfdcUrl(instance);
    const userInfoUrl = `${baseUrl}services/oauth2/userinfo`;
    const headers = Object.assign({ Authorization: `Bearer ${accessToken}` }, SFDX_HTTP_HEADERS);
    try {
      this.logger.info(`Sending request for Username after successful auth code exchange to URL: ${userInfoUrl}`);
      let response = await new Transport().httpRequest({ url: userInfoUrl, headers });
      if (response.statusCode >= 400) {
        this.throwUserGetException(response);
      } else {
        const userInfoJson = parseJsonMap(response.body) as UserInfoResult;
        const url = `${baseUrl}/services/data/${apiVersion}/sobjects/User/${userInfoJson.user_id}`;
        this.logger.info(`Sending request for User SObject after successful auth code exchange to URL: ${url}`);
        response = await new Transport().httpRequest({ url, headers });
        if (response.statusCode >= 400) {
          this.throwUserGetException(response);
        } else {
          // eslint-disable-next-line camelcase
          userInfoJson.preferred_username = (parseJsonMap(response.body) as User).Username;
        }
        return { username: userInfoJson.preferred_username, organizationId: userInfoJson.organization_id };
      }
    } catch (err) {
      throw SfdxError.create('@salesforce/core', 'core', 'AuthCodeUsernameRetrievalError', [err.message]);
    }
  }

  /**
   * Given an error while getting the User object, handle different possibilities of response.body.
   *
   * @param response
   * @private
   */
  private throwUserGetException(response: unknown) {
    let messages = '';
    const bodyAsString = getString(response, 'body', JSON.stringify({ message: 'UNKNOWN', errorCode: 'UNKNOWN' }));
    try {
      const body = parseJson(bodyAsString);
      if (isArray(body)) {
        messages = body
          .map((line) => getString(line, 'message') ?? getString(line, 'errorCode', 'UNKNOWN'))
          .join(os.EOL);
      } else {
        messages = getString(body, 'message') ?? getString(body, 'errorCode', 'UNKNOWN');
      }
    } catch (err) {
      messages = `${bodyAsString}`;
    }
    throw new SfdxError(messages);
  }
}

export namespace AuthInfo {
  /**
   * Constructor options for AuthInfo.
   */
  export interface Options {
    /**
     * Org signup username.
     */
    username?: string;
    /**
     * OAuth options.
     */
    oauth2Options?: OAuth2Options;
    /**
     * Options for the access token auth.
     */
    accessTokenOptions?: AccessTokenOptions;

    oauth2?: OAuth2;

    /**
     * In certain situations, a new auth info wants to use the connected app
     * information from another parent org. Typically for scratch org or sandbox
     * creation.
     */
    parentUsername?: string;

    isDevHub?: boolean;
  }
}
