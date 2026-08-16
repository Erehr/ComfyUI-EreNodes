const cache = new Map();
const notFound = Symbol('notFound'); // Sentinel for missing/absent content (404/204)

/**
 * True when getCache resolved to "there is no such content" (204/404/empty).
 *
 * The sentinel is deliberately not exported directly: callers only ever need to
 * test for it, and handing out the Symbol invites it being stored somewhere.
 * Callers that skip this check end up assigning a Symbol to e.g. `img.src`,
 * which throws "Cannot convert a Symbol value to a string".
 *
 * @param {any} value Result of getCache()
 * @returns {boolean}
 */
export function isNotFound(value) {
    return value === notFound;
}

/**
 * Fetches and caches content. Returns cached data directly if available, or a Promise if fetching.
 * @param {string} url The URL of the content to fetch.
 * @param {string} type The type of content to cache (json, src).
 * @returns {any|Promise<any>} Cached data or Promise
 */
export function getCache(url, type = 'json') {
    const cacheKey = `${type}:${url}`;
    const cached = cache.get(cacheKey);

    // If already cached and resolved, return the data directly
    if (cached && !(cached instanceof Promise) && cached !== notFound) {
        return cached;
    }

    // If marked as not found, return the notFound symbol
    if (cached === notFound) {
        return notFound;
    }

    // If currently loading, return the existing promise
    if (cached instanceof Promise) {
        return cached;
    }

    // Not cached yet, create and cache the promise
    const promise = new Promise(async (resolve, reject) => {
        try {
            const response = await fetch(url);
            if (response.status === 204) {
                // Treat 204 No Content the same as missing content
                cache.set(cacheKey, notFound);
                resolve(notFound);
                return;
            }
            if (response.ok) {
                let data;
                switch (type) {
                    case 'json': {
                        // Guard against empty body for safety
                        const text = await response.text();
                        data = text ? JSON.parse(text) : null;
                        break;
                    }
                    case 'src': {
                        const blobSrc = await response.blob();
                        // Empty blob -> treat as no content
                        if (!blobSrc || blobSrc.size === 0) {
                            cache.set(cacheKey, notFound);
                            resolve(notFound);
                            return;
                        }
                        data = URL.createObjectURL(blobSrc);
                        break;
                    }
                    default:
                        throw new Error(`Unsupported cache type: ${type}`);
                }
                cache.set(cacheKey, data); // Store the actual data
                resolve(data);
            } else if (response.status === 404) {
                cache.set(cacheKey, notFound);
                // Resolve to sentinel instead of rejecting to avoid console spam loops
                resolve(notFound);
            } else {
                // For other errors, do not cache the failure; surface the error once
                cache.delete(cacheKey);
                reject(new Error(`Failed to fetch content: ${response.status} ${response.statusText}`));
            }
        } catch (error) {
            cache.delete(cacheKey);
            reject(error);
        }
    });

    cache.set(cacheKey, promise);
    return promise;
}

/**
 * Manually updates the cache with new content.
 * @param {string} url The URL to associate with the content.
 * @param {any} data The content data.
 */
export function updateCache(url, data, type = 'json') {
    const cacheKey = `${type}:${url}`;
    cache.set(cacheKey, data);
}

/**
 * Clears a specific URL from the cache (all content types).
 * @param {string} url The URL to remove.
 */
export function clearCache(url) {
    // Clear all types for this URL
    for (const key of cache.keys()) {
        if (key.endsWith(`:${url}`)) {
            const val = cache.get(key);
            cache.delete(key);
            if (typeof val === 'string' && val.startsWith('blob:')) {
                try { URL.revokeObjectURL(val); } catch {}
            }
        }
    }
}

/**
 * Clears every cache entry whose URL starts with the given prefix
 * (all content types, including entries with query strings - used to
 * invalidate preview thumbnails after an image is replaced).
 * @param {string} urlPrefix
 */
export function clearCachePrefix(urlPrefix) {
    for (const key of cache.keys()) {
        const url = key.slice(key.indexOf(':') + 1);
        if (url.startsWith(urlPrefix)) {
            const val = cache.get(key);
            cache.delete(key);
            if (typeof val === 'string' && val.startsWith('blob:')) {
                try { URL.revokeObjectURL(val); } catch {}
            }
        }
    }
}
