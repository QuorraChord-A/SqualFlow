const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const loadingPage = fs.readFileSync(path.join(__dirname, "..", "assets", "loading.html"), "utf8");
const desktopMain = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const loadingSource = fs.readFileSync(path.join(__dirname, "..", "assets", "icon-source.png"));

test("keeps the loading icon centered in the viewport", () => {
  assert.match(loadingPage, /min-height:\s*100vh/);
  assert.match(loadingPage, /place-items:\s*center/);
});

test("uses one soft warm canvas with the high-resolution icon source", () => {
  assert.match(loadingPage, /background:\s*#f9f5ec/);
  assert.match(desktopMain, /const loadingPageBackground = "#f9f5ec"/);
  assert.match(desktopMain, /backgroundColor:\s*loadingPageBackground/);
  assert.equal(loadingSource.readUInt32BE(16), 1254);
  assert.equal(loadingSource.readUInt32BE(20), 1254);
  assert.equal(loadingPage.match(/href="icon-source\.png"/g)?.length, 3);
  assert.doesNotMatch(loadingPage, /icon-loading-background\.png/);
  assert.doesNotMatch(loadingPage, /href="icon-loading\.png"/);
  assert.doesNotMatch(loadingPage, /(?:box-shadow|drop-shadow|data-theme)/);
});

test("draws exactly three continuous SVG strokes with the exact icon textures", () => {
  assert.equal(loadingPage.match(/<path class="stroke [^"]+-stroke"/g)?.length, 3);
  assert.match(loadingPage, /class="stroke inner-stroke" pathLength="1"/);
  assert.match(loadingPage, /class="stroke outer-stroke" pathLength="1"/);
  assert.match(loadingPage, /class="stroke accent-stroke" pathLength="1"/);
  assert.match(loadingPage, /animation:\s*draw-stroke 1100ms ease-in-out/);
  assert.match(loadingPage, /animation:\s*draw-stroke 1500ms 1100ms ease-in-out/);
  assert.match(loadingPage, /animation:\s*draw-stroke 500ms 2600ms ease-in-out/);
  assert.match(loadingPage, /id="outer-texture"[\s\S]*href="icon-source\.png"/);
  assert.match(loadingPage, /id="inner-texture"[\s\S]*href="icon-source\.png"/);
  assert.match(loadingPage, /id="accent-texture"[\s\S]*href="icon-source\.png"/);
  assert.match(loadingPage, /stroke:\s*url\(#outer-texture\)/);
  assert.match(loadingPage, /stroke:\s*url\(#inner-texture\)/);
  assert.match(loadingPage, /stroke:\s*url\(#accent-texture\)/);
  assert.doesNotMatch(loadingPage, /exact-icon|show-exact|hide-strokes/);
  assert.doesNotMatch(loadingPage, /<mask|\smask=|drawing-layer|complete-layer/);
});
