export class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, "Can't reach the app's server. Is it running?");
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    throw new ApiError(res.status, "Can't reach the app's server. Is it running?");
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || "Something went wrong.", data);
  return data;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body = {}) => request("POST", path, body),
  del: (path) => request("DELETE", path),
};
