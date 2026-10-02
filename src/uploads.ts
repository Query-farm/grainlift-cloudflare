// Copyright (c) 2026 Query Farm LLC
// SPDX-License-Identifier: Apache-2.0

// Externalized requests and responses for VGI-RPC, kept in an R2 bucket.
//
// A client whose request exceeds the gateway's request limit asks for an
// upload URL, PUTs the request there, and sends only a pointer; large
// responses are stored the same way and the client fetches them by URL. The
// URLs point at this Worker (`/_uploads/<key>`), signed with an HMAC so they
// cannot be forged and expire, and the Worker streams bodies to and from R2
// through its binding: no R2 API credentials, and nothing buffered on the way.
// The gateway reads uploaded objects straight from the bucket.

const ROUTE = "/_uploads/";
/** How long a vended URL stays valid. */
const TTL_MS = 15 * 60_000;

type Method = "PUT" | "GET";

export class R2Uploads {
  private readonly key: Promise<CryptoKey>;

  constructor(
    private readonly bucket: R2Bucket,
    secret: string,
    /** This Worker's public URL, which vended URLs point at. */
    private readonly baseUrl: string,
    /** Browser origin allowed to upload and download (e.g. Cupola). */
    private readonly corsOrigin?: string,
  ) {
    this.key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }

  /** VGI-RPC `uploadUrlProvider`: a fresh object to PUT, and how to read it back. */
  readonly provider = {
    generateUploadUrl: async () => {
      const key = crypto.randomUUID();
      const expires = Date.now() + TTL_MS;
      return {
        uploadUrl: await this.url(key, "PUT", expires),
        downloadUrl: await this.url(key, "GET", expires),
        expiresAt: new Date(expires),
      };
    },
  };

  /** VGI-RPC `externalLocation.storage`: store a large response, return its URL. */
  readonly storage = {
    upload: async (data: Uint8Array, contentEncoding: string) => {
      const key = crypto.randomUUID();
      await this.bucket.put(key, data, contentEncoding ? { httpMetadata: { contentEncoding } } : undefined);
      return this.url(key, "GET", Date.now() + TTL_MS);
    },
  };

  /**
   * VGI-RPC `externalLocation.fetch`: the gateway reads its own URLs straight
   * from the bucket (a Worker cannot fetch its own hostname), anything else
   * over the network.
   */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== new URL(this.baseUrl).origin || !url.pathname.startsWith(ROUTE)) return fetch(input, init);
    return this.serve("GET", url, null);
  }) as typeof fetch;

  /** The Worker's `/_uploads/` route, or null for any other path. */
  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(ROUTE)) return null;
    if (request.method === "OPTIONS") return this.cors(new Response(null, { status: 204 }), true);
    if (request.method !== "PUT" && request.method !== "GET") return this.cors(new Response(null, { status: 405 }));
    return this.cors(await this.serve(request.method, url, request.body));
  }

  private async serve(method: Method, url: URL, body: ReadableStream | null): Promise<Response> {
    const key = url.pathname.slice(ROUTE.length);
    const expires = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("signature") ?? "";
    if (!key || !(expires > Date.now()) || !(await this.verify(key, method, expires, signature))) {
      return new Response("Invalid or expired upload URL", { status: 403 });
    }
    if (method === "PUT") {
      if (!body) return new Response("Missing body", { status: 400 });
      // Streamed into R2, never held whole in the Worker.
      await this.bucket.put(key, body);
      return new Response(null, { status: 200 });
    }
    const object = await this.bucket.get(key);
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers({ "Content-Type": "application/vnd.apache.arrow.stream" });
    if (object.httpMetadata?.contentEncoding) headers.set("Content-Encoding", object.httpMetadata.contentEncoding);
    return new Response(object.body, { headers });
  }

  private cors(response: Response, preflight = false): Response {
    if (!this.corsOrigin) return response;
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", this.corsOrigin);
    if (preflight) {
      headers.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Content-Encoding");
      headers.set("Access-Control-Max-Age", "600");
    }
    return new Response(response.body, { status: response.status, headers });
  }

  private async url(key: string, method: Method, expires: number): Promise<string> {
    const signature = await this.sign(key, method, expires);
    return `${this.baseUrl}${ROUTE}${key}?expires=${expires}&signature=${signature}`;
  }

  private async sign(key: string, method: Method, expires: number): Promise<string> {
    const mac = await crypto.subtle.sign("HMAC", await this.key, new TextEncoder().encode(`${method}\n${key}\n${expires}`));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async verify(key: string, method: Method, expires: number, signature: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;
    const bytes = Uint8Array.from(signature.match(/../g)!, (h) => Number.parseInt(h, 16));
    return crypto.subtle.verify("HMAC", await this.key, bytes, new TextEncoder().encode(`${method}\n${key}\n${expires}`));
  }
}
