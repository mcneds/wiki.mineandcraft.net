export function createApi({ csrf, onUnauthorized = () => {} }) {
  return async function api(path, method = 'GET', body, { onProgress } = {}) {
    const multipart = body instanceof FormData;
    const headers = { ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-CSRF-Token': csrf() } : {}) };
    const payload = body ? multipart ? body : JSON.stringify(body) : undefined;
    const response = onProgress ? await new Promise((resolve, reject) => {
      const request = new XMLHttpRequest(); request.open(method, path); request.withCredentials = true; request.timeout = 60000;
      for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
      request.upload.onprogress = event => onProgress(event.loaded, event.lengthComputable ? event.total : 0);
      request.onload = () => resolve(new Response(request.responseText, { status: request.status, headers: { 'Retry-After': request.getResponseHeader('Retry-After') || '' } }));
      request.onerror = request.ontimeout = request.onabort = () => reject(new Error('The upload connection failed. Please retry.'));
      request.send(payload);
    }) : await fetch(path, {
      method, credentials: 'same-origin',
      headers, ...(payload ? { body: payload } : {}),
    });
    if (response.status === 204) return;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) onUnauthorized();
      throw Object.assign(new Error(result.error || 'The request could not be completed. Please try again.'), { status: response.status, code: result.code, retryAfter: Number(result.retryAfter || response.headers.get('Retry-After')) || 0 });
    }
    return result;
  };
}
