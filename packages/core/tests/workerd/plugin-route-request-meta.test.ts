/**
 * Plugin routes reached through the MCP tool bridge or a content editor
 * extension must see the client's `ctx.requestMeta` on Cloudflare.
 *
 * Regression: both paths replace the request body by building a new
 * `Request` from `request.url`, which drops the Workers `cf` object.
 * `extractRequestMeta` trusts `CF-Connecting-IP` and reads geo only when
 * `cf` is present, so the handler got `ip: null` and `geo: null`.
 */

import { env } from "cloudflare:workers";
import { Kysely } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import type { Database } from "../../src/database/types.js";
import { EmDashRuntime } from "../../src/emdash-runtime.js";
import { definePlugin } from "../../src/plugins/define-plugin.js";
import { dispatchPluginEditorExtensionApiRequest } from "../../src/plugins/http-route-dispatch.js";
import { extractRequestMeta } from "../../src/plugins/request-meta.js";
import type { RouteCallerInput } from "../../src/plugins/routes.js";
import type { RequestMeta } from "../../src/plugins/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
		}
	}
}

const CLIENT_IP = "203.0.113.7";
const CLIENT_GEO = { country: "PT", region: "Lisbon", city: "Lisbon" };

const caller: RouteCallerInput = {
	id: "owner",
	email: "owner@example.com",
	name: "Owner",
	role: 50,
	createdAt: "2026-01-01T00:00:00.000Z",
};

function cloudflareRequest(url: string, body: unknown): Request {
	return new Request(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"CF-Connecting-IP": CLIENT_IP,
			"X-EmDash-Request": "1",
		},
		body: JSON.stringify(body),
		cf: CLIENT_GEO,
	});
}

describe("plugin route requestMeta on Cloudflare", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;
	let seen: RequestMeta | undefined;

	beforeAll(() => {
		db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	});

	beforeEach(async () => {
		await resetD1Schema(db);
		seen = undefined;
		runtime = await EmDashRuntime.create({
			config: { database: { entrypoint: crypto.randomUUID(), config: {}, type: "sqlite" } },
			plugins: [
				definePlugin({
					id: "request-meta-probe",
					version: "1.0.0",
					routes: {
						meta: {
							handler: async (ctx) => {
								seen = ctx.requestMeta;
								return { blocks: [] };
							},
						},
					},
					admin: {
						editorPanels: [{ id: "meta", title: "Meta", route: "meta" }],
					},
				}),
			],
			createDialect: () => new RawBindingD1Dialect({ database: env.DB }),
			createStorage: null,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});
	});

	afterEach(async () => {
		await runtime.shutdown();
	});

	it("keeps the client IP and geo for an MCP tool call", async () => {
		const request = cloudflareRequest("https://example.com/_emdash/api/mcp", {
			jsonrpc: "2.0",
			method: "tools/call",
		});
		expect(extractRequestMeta(request).ip).toBe(CLIENT_IP);

		const result = await runtime.handlePluginMcpTool(
			"request-meta-probe",
			"meta",
			"meta",
			{},
			caller.id,
			request,
			caller,
		);

		expect(result.success).toBe(true);
		expect(seen?.ip).toBe(CLIENT_IP);
		expect(seen?.geo).toEqual(CLIENT_GEO);
	});

	it("keeps the client IP and geo for a content editor panel", async () => {
		vi.spyOn(runtime, "handleContentGet").mockResolvedValue({
			success: true,
			data: { item: { id: "entry-1", authorId: caller.id, locale: "en", version: 1 } },
		});
		const request = cloudflareRequest(
			"https://example.com/_emdash/api/content/posts/entry-1/plugin-extensions/request-meta-probe/panel/meta",
			{ type: "panel_load" },
		);
		expect(extractRequestMeta(request).ip).toBe(CLIENT_IP);

		const response = await dispatchPluginEditorExtensionApiRequest({
			runtime,
			pluginId: "request-meta-probe",
			kind: "panel",
			extensionId: "meta",
			collection: "posts",
			entryId: "entry-1",
			request,
			user: caller,
		});

		expect(response.status).toBe(200);
		expect(seen?.ip).toBe(CLIENT_IP);
		expect(seen?.geo).toEqual(CLIENT_GEO);
	});
});
