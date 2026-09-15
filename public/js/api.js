async function request(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: body && !(body instanceof Blob) ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

const enc = encodeURIComponent;

export const api = {
  listAirports: () => request('GET', '/api/airports'),
  airport: (icao) => request('GET', `/api/airports/${enc(icao)}`),
  setPreferredSource: (icao, preferredSource) => request('PUT', `/api/airports/${enc(icao)}/meta`, { preferredSource }),
  loadSource: (icao, source, { refresh = false } = {}) =>
    request('GET', `/api/airports/${enc(icao)}/sources/${source}${refresh ? '?refresh=1' : ''}`),
  saveTrace: (icao, features) => request('PUT', `/api/airports/${enc(icao)}/sources/trace`, { features }),
  uploadChart: (icao, file, width, height) =>
    request('PUT', `/api/airports/${enc(icao)}/chart?width=${width}&height=${height}`, file, { 'Content-Type': file.type }),
};
