// frontend/lib/api-client.ts
// Centralized API client with silent refresh and typed HTTP methods


/**
 * Where REST calls go.
 *
 * In proxy mode (NEXT_PUBLIC_API_PROXY=true, the deployed setting) calls are
 * same-origin and next.config.mjs rewrites /api/v1/* to the Control Plane.
 * That is what makes the refresh-token cookie first-party: the frontend and
 * the Control Plane live on different sites (vercel.app vs onrender.com), and
 * a cookie set cross-site is not sent on fetch with SameSite=Lax — and on
 * Safari is blocked outright as a third-party cookie. Without the proxy,
 * every page reload would log the user out.
 *
 * WebSockets cannot go through the proxy, and do not need to: they
 * authenticate with the access token, not a cookie. See realtime.ts.
 */
function resolveApiBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_API_PROXY === 'true') {
    return '';
  }
  if (
    process.env.NEXT_PUBLIC_API_URL &&
    !process.env.NEXT_PUBLIC_API_URL.includes('localhost')
  ) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  if (typeof window !== 'undefined') {
    const isLocal =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1';
    if (!isLocal) {
      return '';
    }
  }
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
}

export const API_BASE_URL = resolveApiBaseUrl();

let currentAccessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
let onAuthFailureCallback: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  currentAccessToken = token;
}

export function getAccessToken(): string | null {
  return currentAccessToken;
}

export function setOnAuthFailure(cb: () => void): void {
  onAuthFailureCallback = cb;
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/**
 * Exchange the refresh cookie for a fresh access token. Shared by REST
 * (on a 401) and the realtime socket (before connecting, and on a 4001
 * close), and de-duplicated so concurrent callers share one request.
 */
export async function requestRefreshToken(): Promise<string | null> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Type': 'web',
        },
        credentials: 'include',
        body: JSON.stringify({}),
      });

      if (!res.ok) {
        setAccessToken(null);
        if (onAuthFailureCallback) {
          onAuthFailureCallback();
        }
        return null;
      }

      const data = (await res.json()) as { accessToken?: string };
      if (data.accessToken) {
        setAccessToken(data.accessToken);
        return data.accessToken;
      }
      return null;
    } catch {
      setAccessToken(null);
      if (onAuthFailureCallback) {
        onAuthFailureCallback();
      }
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function fetchWithAuth<T = unknown>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;

  const headers = new Headers(options.headers || {});
  headers.set('X-Client-Type', 'web');
  if (!headers.has('Content-Type') && options.body && typeof options.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  if (currentAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${currentAccessToken}`);
  }

  const fetchOptions: RequestInit = {
    ...options,
    headers,
    credentials: 'include',
  };

  let res = await fetch(url, fetchOptions);

  // If 401 Unauthorized, attempt silent token refresh once
  if (res.status === 401 && !endpoint.includes('/api/v1/auth/')) {
    const newToken = await requestRefreshToken();
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      res = await fetch(url, { ...fetchOptions, headers });
    }
  }

  if (!res.ok) {
    let errorData: unknown;
    let message = `Request failed with status ${res.status}`;
    try {
      errorData = await res.json();
      if (
        errorData &&
        typeof errorData === 'object' &&
        'error' in errorData &&
        typeof (errorData as { error: unknown }).error === 'string'
      ) {
        message = (errorData as { error: string }).error;
      }
    } catch {
      /* non-json error response */
    }
    throw new ApiError(res.status, message, errorData);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return (await res.json()) as T;
}

export const apiClient = {
  get<T = unknown>(endpoint: string, options?: RequestInit): Promise<T> {
    return fetchWithAuth<T>(endpoint, { ...options, method: 'GET' });
  },

  post<T = unknown>(endpoint: string, body?: unknown, options?: RequestInit): Promise<T> {
    return fetchWithAuth<T>(endpoint, {
      ...options,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  put<T = unknown>(endpoint: string, body?: unknown, options?: RequestInit): Promise<T> {
    return fetchWithAuth<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  patch<T = unknown>(endpoint: string, body?: unknown, options?: RequestInit): Promise<T> {
    return fetchWithAuth<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  },

  delete<T = unknown>(endpoint: string, options?: RequestInit): Promise<T> {
    return fetchWithAuth<T>(endpoint, { ...options, method: 'DELETE' });
  },
};
