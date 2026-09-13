import { describe, expect, test } from "bun:test";
import { chatCompletion } from "./llm";

describe("chatCompletion", () => {
  test("returns the assistant text from an OpenAI-compatible response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({
          choices: [{ message: { role: "assistant", content: "  Updated. " } }],
        }),
    });
    try {
      const text = await chatCompletion({
        endpoint: `http://127.0.0.1:${server.port}/v1`,
        model: "glm-4",
        apiKey: "sk-test",
        system: "s",
        user: "u",
      });
      expect(text).toBe("Updated.");
    } finally {
      server.stop(true);
    }
  });

  test("posts the expected body to {endpoint}/chat/completions with bearer auth", async () => {
    type Capture = {
      url: string;
      auth: string | null;
      body: {
        model: string;
        max_tokens: number;
        messages: { role: string; content: string }[];
      };
    };
    // assigned inside the handler closure — defeat initializer narrowing
    let captured: Capture | null = null as Capture | null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        captured = {
          url: req.url,
          auth: req.headers.get("authorization"),
          body: (await req.json()) as Capture["body"],
        };
        return Response.json({ choices: [{ message: { content: "ok" } }] });
      },
    });
    try {
      const text = await chatCompletion({
        endpoint: `http://127.0.0.1:${server.port}/v1/`,
        model: "glm-4",
        apiKey: "sk-test",
        system: "be brief",
        user: "summarize this",
      });
      expect(text).toBe("ok");
      expect(captured!.url.endsWith("/v1/chat/completions")).toBe(true);
      expect(captured!.auth).toBe("Bearer sk-test");
      expect(captured!.body.model).toBe("glm-4");
      expect(captured!.body.max_tokens).toBeGreaterThan(0);
      expect(captured!.body.messages).toEqual([
        { role: "system", content: "be brief" },
        { role: "user", content: "summarize this" },
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("any non-ok response yields null", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({}, { status: 401 }),
    });
    try {
      const text = await chatCompletion({
        endpoint: `http://127.0.0.1:${server.port}`,
        model: "m",
        apiKey: "bad",
        system: "s",
        user: "u",
      });
      expect(text).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("an unreachable endpoint yields null instead of throwing", async () => {
    const text = await chatCompletion({
      endpoint: "http://127.0.0.1:1",
      model: "m",
      apiKey: "k",
      system: "s",
      user: "u",
    });
    expect(text).toBeNull();
  });

  test("an unexpected response shape yields null", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ surprise: true }),
    });
    try {
      const text = await chatCompletion({
        endpoint: `http://127.0.0.1:${server.port}`,
        model: "m",
        apiKey: "k",
        system: "s",
        user: "u",
      });
      expect(text).toBeNull();
    } finally {
      server.stop(true);
    }
  });

  test("a reasoning budget blowout retries once at four times the cap", async () => {
    const caps: number[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { max_tokens: number };
        caps.push(body.max_tokens);
        if (caps.length === 1) {
          // the whole budget went to reasoning — no visible content at all
          return Response.json({
            choices: [{ finish_reason: "length", message: { content: "" } }],
          });
        }
        return Response.json({
          choices: [{ message: { content: "Recovered summary." } }],
        });
      },
    });
    try {
      const text = await chatCompletion({
        endpoint: `http://127.0.0.1:${server.port}`,
        model: "m",
        apiKey: "k",
        system: "s",
        user: "u",
      });
      expect(text).toBe("Recovered summary.");
      expect(caps).toEqual([4096, 16384]);
    } finally {
      server.stop(true);
    }
  });

  test("a blowout that blows again yields null after the retry", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls += 1;
        return Response.json({
          choices: [{ finish_reason: "length", message: { content: " " } }],
        });
      },
    });
    try {
      const text = await chatCompletion({
        endpoint: `http://127.0.0.1:${server.port}`,
        model: "m",
        apiKey: "k",
        system: "s",
        user: "u",
      });
      expect(text).toBeNull();
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("an empty answer without the length signature is not retried", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls += 1;
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "" } }],
        });
      },
    });
    try {
      const text = await chatCompletion({
        endpoint: `http://127.0.0.1:${server.port}`,
        model: "m",
        apiKey: "k",
        system: "s",
        user: "u",
      });
      expect(text).toBeNull();
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
