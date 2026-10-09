import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { executeCollectionDeletionGuard } from "../../../cloudflare/src/db/d1.js";
import { handleContentCreate } from "../../src/api/index.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { CommentRepository } from "../../src/database/repositories/comment.js";
import { EntryLockRepository } from "../../src/database/repositories/entry-locks.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { activateMediaUsageCapture } from "../../src/media/usage/activation.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

vi.mock("virtual:emdash/dialect", () => ({
	executeCollectionDeletionGuard: (
		_config: unknown,
		input: Parameters<typeof executeCollectionDeletionGuard>[1],
	) => executeCollectionDeletionGuard({ binding: "DB" }, input),
}));

const USER_ID = "user-1";

let db: Kysely<Database>;
let bylineId: string;
let termGroup: string;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await resetD1Schema(db);
	await runMigrations(db);

	await db
		.insertInto("users")
		.values({
			id: USER_ID,
			email: "editor@example.com",
			name: "Editor",
			avatar_url: null,
			role: 40,
			email_verified: 1,
			data: null,
		})
		.execute();
	bylineId = (await new BylineRepository(db).create({ slug: "jane", displayName: "Jane" })).id;
	const term = await new TaxonomyRepository(db).create({ name: "tag", slug: "news", label: "News" });
	termGroup = term.translationGroup ?? term.id;
});

afterAll(async () => {
	await db.destroy();
});

/** Creates a collection holding one entry with every kind of per-entry record. */
async function seedCollection(slug: string): Promise<void> {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug, label: slug, hasSeo: true });
	await registry.createField(slug, { slug: "title", label: "Title", type: "string" });

	const created = await handleContentCreate(db, slug, {
		data: { title: "Hello" },
		bylines: [{ bylineId }],
		seo: { title: "Hello", description: "An entry" },
	});
	if (!created.success) throw new Error(`Failed to create entry: ${JSON.stringify(created)}`);
	const entryId = created.data!.item.id;

	await new RevisionRepository(db).create({ collection: slug, entryId, data: { title: "Hello" } });
	await new CommentRepository(db).create({
		collection: slug,
		contentId: entryId,
		authorName: "Reader",
		authorEmail: "reader@example.com",
		body: "Nice",
		status: "pending",
	});
	await new TaxonomyRepository(db).attachGroupsToEntry(slug, entryId, [termGroup]);
	const lock = await new EntryLockRepository(db).acquire({
		collection: slug,
		entryId,
		userId: USER_ID,
		token: "tab-1",
		leaseSeconds: 60,
	});
	expect(lock.outcome).toBe("acquired");
}

async function countRows(slug: string): Promise<Record<string, number>> {
	const count = async (query: { executeTakeFirst(): Promise<{ n: number | string | bigint }> }) =>
		Number((await query.executeTakeFirst()).n);
	return {
		revisions: await count(
			db
				.selectFrom("revisions")
				.select((eb) => eb.fn.countAll().as("n"))
				.where("collection", "=", slug),
		),
		revisionPruneQueue: await count(
			db
				.selectFrom("_emdash_revision_prune_queue")
				.select((eb) => eb.fn.countAll().as("n"))
				.where("collection", "=", slug),
		),
		seo: await count(
			db
				.selectFrom("_emdash_seo")
				.select((eb) => eb.fn.countAll().as("n"))
				.where("collection", "=", slug),
		),
		comments: await count(
			db
				.selectFrom("_emdash_comments")
				.select((eb) => eb.fn.countAll().as("n"))
				.where("collection", "=", slug),
		),
		contentBylines: await count(
			db
				.selectFrom("_emdash_content_bylines")
				.select((eb) => eb.fn.countAll().as("n"))
				.where("collection_slug", "=", slug),
		),
		contentTaxonomies: await count(
			db
				.selectFrom("content_taxonomies")
				.select((eb) => eb.fn.countAll().as("n"))
				.where("collection", "=", slug),
		),
		entryLocks: await count(
			db
				.selectFrom("_emdash_entry_locks")
				.select((eb) => eb.fn.countAll().as("n"))
				.where("collection", "=", slug),
		),
	};
}

const NONE = {
	revisions: 0,
	revisionPruneQueue: 0,
	seo: 0,
	comments: 0,
	contentBylines: 0,
	contentTaxonomies: 0,
	entryLocks: 0,
};

describe("force-deleting a collection on D1", () => {
	it("removes the records its entries held in shared tables", async () => {
		await seedCollection("articles");
		for (const [table, rows] of Object.entries(await countRows("articles"))) {
			expect(rows, table).toBeGreaterThan(0);
		}

		await new SchemaRegistry(db).deleteCollection("articles", { force: true });

		expect(await countRows("articles")).toEqual(NONE);
	});

	it("removes them once media usage capture is active", async () => {
		await activateMediaUsageCapture(db, { writersDrained: true });
		await seedCollection("products");
		for (const [table, rows] of Object.entries(await countRows("products"))) {
			expect(rows, table).toBeGreaterThan(0);
		}

		await new SchemaRegistry(db).deleteCollection("products", { force: true });

		expect(await countRows("products")).toEqual(NONE);
	});
});
