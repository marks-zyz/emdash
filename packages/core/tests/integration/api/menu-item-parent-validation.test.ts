/**
 * Menu item parent validation
 *
 * A menu item's parent must exist in the same menu, must not be the item itself,
 * and must not create a cycle. Taxonomy terms already enforce this; menu items
 * are written straight through, and the tree builder then drops the items it
 * cannot reach.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleMenuCreate,
	handleMenuItemCreate,
	handleMenuItemReorder,
	handleMenuItemUpdate,
} from "../../../src/api/handlers/menus.js";
import type { Database } from "../../../src/database/types.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

async function createItem(db: Kysely<Database>, menu: string, label: string): Promise<string> {
	const res = await handleMenuItemCreate(db, menu, {
		type: "custom",
		label,
		customUrl: `/${label.toLowerCase()}`,
		sortOrder: 0,
	});
	if (!res.success) throw new Error(`could not create ${label}`);
	return res.data.id;
}

describe("menu item parent validation", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await handleMenuCreate(db, { name: "primary", label: "Primary" });
		await handleMenuCreate(db, { name: "footer", label: "Footer" });
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("rejects a reorder that makes two items each other's parent", async () => {
		const a = await createItem(db, "primary", "A");
		const b = await createItem(db, "primary", "B");

		const res = await handleMenuItemReorder(db, "primary", [
			{ id: a, parentId: b, sortOrder: 0 },
			{ id: b, parentId: a, sortOrder: 1 },
		]);

		expect(res.success).toBe(false);
	});

	it("keeps both items in the menu after a two-item cycle is submitted", async () => {
		const a = await createItem(db, "primary", "A");
		const b = await createItem(db, "primary", "B");

		await handleMenuItemReorder(db, "primary", [
			{ id: a, parentId: b, sortOrder: 0 },
			{ id: b, parentId: a, sortOrder: 1 },
		]);

		const menu = await getMenuWithDb("primary", db);
		expect(menu?.items).toHaveLength(2);
	});

	it("rejects an item set as its own parent", async () => {
		const a = await createItem(db, "primary", "A");

		const res = await handleMenuItemUpdate(db, "primary", a, { parentId: a });

		expect(res.success).toBe(false);
	});

	it("rejects a parent that belongs to another menu", async () => {
		const a = await createItem(db, "primary", "A");
		const other = await createItem(db, "footer", "Other");

		const res = await handleMenuItemUpdate(db, "primary", a, { parentId: other });

		expect(res.success).toBe(false);
	});
});
