// Thin fetch wrapper. The X-Requested-With header is required by the server
// for every state-changing call (cross-site pages cannot set it).

export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Requested-With': 'econlab',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check your connection.');
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') onUnauthorized();
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data);
  }
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);
