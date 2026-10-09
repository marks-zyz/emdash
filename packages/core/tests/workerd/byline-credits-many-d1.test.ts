import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate } from "../../src/api/index.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const COLLECTION = "posts";
/** One bound parameter per distinct byline id, so 120 credits need 120 in one lookup. */
const BYLINE_COUNT = 120;

let db: Kysely<Database>;
let bylines: BylineRepository;
let bylineIds: string[];

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "Posts", labelSingular: "Post" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });

	bylines = new BylineRepository(db);
	bylineIds = [];
	for (let i = 0; i < BYLINE_COUNT; i++) {
		const byline = await bylines.create({ slug: `author-${i}`, displayName: `Author ${i}` });
		bylineIds.push(byline.id);
	}
});

afterAll(async () => {
	await db.destroy();
});

async function createEntry(title: string): Promise<string> {
	const result = await handleContentCreate(db, COLLECTION, { data: { title } });
	if (!result.success) throw new Error(`Failed to create entry: ${JSON.stringify(result)}`);
	return result.data!.item.id;
}

describe("content byline credits on D1", () => {
	it("sets more credits than fit in one statement", async () => {
		const entryId = await createEntry("Many authors");

		const credits = await bylines.setContentBylines(
			COLLECTION,
			entryId,
			bylineIds.map((bylineId) => ({ bylineId })),
		);

		expect(credits.map((credit) => credit.byline.id)).toEqual(bylineIds);
	});

	it("still rejects an unknown byline id among many", async () => {
		const entryId = await createEntry("Unknown author");

		await expect(
			bylines.setContentBylines(
				COLLECTION,
				entryId,
				[...bylineIds, "missing-byline"].map((bylineId) => ({ bylineId })),
			),
		).rejects.toThrow("One or more byline IDs do not exist");
	});
});
