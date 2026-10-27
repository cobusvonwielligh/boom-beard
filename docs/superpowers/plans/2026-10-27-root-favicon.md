# Root Favicon Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing ICO directly available at `https://boombeard.co.za/favicon.ico`.

**Architecture:** Alias only the exact root path to the existing `public/assets/img/favicon.ico` file in the static resolver. Point browser icon metadata at the root URL while keeping the existing PNG and Apple touch icons.

**Tech Stack:** Node.js ESM, Node HTTP server, `node:test`.

---

### Task 1: Add and verify the root favicon alias

**Files:**
- Modify: `test/cache.test.js`
- Modify: `server/index.js`
- Modify: `public/index.html`

- [ ] **Step 1: Add a failing HTTP test**

Inside `test/cache.test.js`'s existing `static caching` test, add:

```js
await t.test('the root favicon aliases the existing ICO asset', async () => {
  const [rootIcon, assetIcon] = await Promise.all([
    fetch(base + '/favicon.ico'),
    fetch(base + '/assets/img/favicon.ico'),
  ]);
  assert.equal(rootIcon.status, 200);
  assert.equal(rootIcon.headers.get('content-type'), 'image/x-icon');
  assert.deepEqual(
    Buffer.from(await rootIcon.arrayBuffer()),
    Buffer.from(await assetIcon.arrayBuffer()),
  );
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test test/cache.test.js`

Expected before implementation: only the new root-favicon assertion fails with a
404; the nested favicon assertion remains green.

- [ ] **Step 3: Alias `/favicon.ico` to the existing ICO file**

In `server/index.js`'s `resolveFile`, after decoding and validating the path, add:

```js
const resolvedPath = clean === '/favicon.ico' ? '/assets/img/favicon.ico' : clean;
```

Use `resolvedPath` for mount matching and the relative path. Retain the existing
mount-boundary check so the alias cannot escape `public/`.

- [ ] **Step 4: Add root favicon metadata**

In the `<head>` of `public/index.html`, add:

```html
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
```

Keep the existing 48px/96px PNG icons and Apple touch icon.

- [ ] **Step 5: Run the focused regression test**

Run: `node --test test/cache.test.js`

Expected: all cache tests pass and `/favicon.ico` is byte-identical to the existing
ICO asset.

- [ ] **Step 6: Commit**

```bash
git add test/cache.test.js server/index.js public/index.html
git commit -m "fix(web): serve the favicon at the root"
```
