async function request(path, { json, ...opts } = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    body: json ? JSON.stringify(json) : opts.body,
  });
  if (res.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new Event('jarvis:signedout'));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
  return res;
}

export const api = {
  get: (p) => request(p).then((r) => r.json()),
  post: (p, json) => request(p, { method: 'POST', json }).then((r) => r.json()),
  put: (p, json) => request(p, { method: 'PUT', json }).then((r) => r.json()),
  patch: (p, json) => request(p, { method: 'PATCH', json }).then((r) => r.json()),
  del: (p) => request(p, { method: 'DELETE' }).then((r) => r.json()),
  upload: (p, form) => request(p, { method: 'POST', body: form }).then((r) => r.json()),
  blob: (p, json) => request(p, { method: 'POST', json }).then((r) => r.blob()),
};

// POST /api/chat and read the server-sent events as they arrive
export async function streamChat(form, { signal, onEvent }) {
  const res = await request('/chat', { method: 'POST', body: form, signal });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = block.match(/^data: (.*)$/m)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}
