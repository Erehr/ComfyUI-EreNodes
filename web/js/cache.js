const cache = new Map();
const notFound = Symbol('notFound'); // Sentinel value for 404s

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
            if (response.ok) {
                let data;
                switch (type) {
                    case 'json':
                        data = await response.json();
                        break;
                    case 'src':
                        const blobSrc = await response.blob();
                        data = URL.createObjectURL(blobSrc);
                        break;
                    case 'bitmap':
                        // Check if we already have a blob from 'src' cache
                        const srcCacheKey = `src:${url}`;
                        const srcCached = cache.get(`src:${url}`);
                        
                        let blob;
                        if (srcCached && !(srcCached instanceof Promise) && srcCached !== notFound) {
                            // Reuse existing blob from src cache
                            const blobUrl = srcCached;
                            const blobResponse = await fetch(blobUrl);
                            blob = await blobResponse.blob();
                        } else {
                            // Fetch new blob
                            blob = await response.blob();
                        }
                        
                        data = await createImageBitmap(blob);
                        break;
                    default:
                        throw new Error(`Unsupported cache type: ${type}`);
                }
                cache.set(cacheKey, data); // Store the actual data
                resolve(data);
            } else if (response.status === 404) {
                cache.set(cacheKey, notFound);
                reject(new Error('Content not found'));
            } else {
                cache.delete(cacheKey);
                reject(new Error(`Failed to fetch content: ${response.statusText}`));
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
 * Clears a specific URL from the cache.
 * @param {string} url The URL to remove.
 */
export function clearCache(url) {
    // Clear all types for this URL
    for (const key of cache.keys()) {
        if (key.endsWith(`:${url}`)) {
            cache.delete(key);
        }
    }
}