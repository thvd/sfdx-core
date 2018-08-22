/*
 * Copyright (c) 2018, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
/**
 * @module sfdc
 */

import { URL } from 'url';
import { findKey, includes, isNil, endsWith } from 'lodash';
import { JsonMap, asJsonMap, isJsonMap } from '@salesforce/ts-types';

/**
 * Returns `true` if a provided URL contains a Salesforce owned domain.
 *
 * @param {string} urlString The URL to inspect.
 * @returns {boolean}
 */
export function isSalesforceDomain(urlString: string): boolean {
    let url: URL;

    try {
        url = new URL(urlString);
    } catch (e) {
        return false;
    }

    // Source https://help.salesforce.com/articleView?id=000003652&type=1
    const whitelistOfSalesforceDomainPatterns: string[] = [
        '.content.force.com',
        '.force.com',
        '.salesforce.com',
        '.salesforceliveagent.com',
        '.secure.force.com'
    ];

    const whitelistOfSalesforceHosts: string[] = [
        'developer.salesforce.com',
        'trailhead.salesforce.com'
    ];

    return !isNil(whitelistOfSalesforceDomainPatterns.find((pattern) => endsWith(url.hostname, pattern))) ||
        includes(whitelistOfSalesforceHosts, url.hostname);
}

/**
 * Converts an 18 character Salesforce ID to 15 characters.
 *
 * @param {string} id The id to convert.
 * @return {string}
 */
export function trimTo15(id: string): string {
    if (id && id.length && id.length > 15) {
        id = id.substring(0, 15);
    }
    return id;
}

/**
 * Tests whether an API version matches the format `i.0`.
 *
 * @param value The API version as a string.
 * @returns {boolean}
 */
export function validateApiVersion(value: string): boolean {
    return isNil(value) || /[1-9]\d\.0/.test(value);
}

/**
 * Tests whether an email matches the format `me@my.org`
 *
 * @param value The email as a string.
 * @returns {boolean}
 */
export function validateEmail(value: string): boolean {
    return /^[^.][^@]*@[^.]+(\.[^.\s]+)+$/.test(value);
}

/**
 * Tests whether a Salesforce ID is in the correct format, a 15- or 18-character length string with only letters and numbers
 * @param value The ID as a string.
 * @returns {boolean}
 */
export function validateSalesforceId(value: string): boolean {
    return /[a-zA-Z0-9]{18}|[a-zA-Z0-9]{15}/.test(value) && (value.length === 15 || value.length === 18);
}

/**
 * Tests whether a path is in the correct format; the value doesn't include the characters "[", "]", "?", "<", ">", "?", "|"
 * @param value The path as a string.
 * @returns {boolean}
 */
export function validatePathDoesNotContainInvalidChars(value: string): boolean {
    return !/[\[:"\?<>\|\]]+/.test(value);
}

/**
 * Returns the first key within the object that has an upper case first letter.
 *
 * @param {JsonMap} data The object in which to check key casing.
 * @returns {string}
 */
export function findUpperCaseKeys(data: JsonMap): string {
    let key: string;
    findKey(data, (val, k) => {
        if (k[0] === k[0].toUpperCase()) {
            key = k;
        } else if (isJsonMap(val)) {
            key = findUpperCaseKeys(asJsonMap(val));
        }
        return key;
    });
    return key;
}
