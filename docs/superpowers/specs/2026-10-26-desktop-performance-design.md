# Desktop Performance Optimization Design

## Goal

Reduce Boom Beard's desktop transfer size and improve repeat-load caching, LCP discovery, accessibility, and SEO without changing game behavior, layout, or the no-build development model.

## Scope

This pass targets the high-impact, low-risk findings from the 26 October 2026 desktop Lighthouse report:

- text responses are not compressed;
- the mascot and bomb-barrel PNG files are much larger than modern equivalents;
- static images and the display font have five-minute cache lifetimes;
- the mascot is the LCP element but lacks high fetch priority;
- the document lacks a language declaration and meta description;
- the document does not declare its canonical URL.

The site remains desktop-only. This work will not introduce mobile layouts, mobile assets, responsive breakpoints, or phone-specific behavior.

## Response Compression

The existing Node static server will gzip text responses when all of these conditions hold:

- the request advertises `gzip` in `Accept-Encoding`;
- the response is HTML, CSS, JavaScript, JSON, XML, or plain text;
- the request is not a byte-range request;
- the file is large enough for compression to be useful.

Compressed responses will include `Content-Encoding: gzip` and `Vary: Accept-Encoding`. Range responses remain byte-for-byte representations of the source file, preserving Safari audio behavior. Existing ETag revalidation remains in place. Compression uses Node's built-in `zlib`, so no runtime dependency or build step is added.

## Desktop Image Delivery

The 384×384 mascot and 440×440 bomb-barrel PNGs will be converted to near-lossless WebP at their existing dimensions. Their HTML and CSS-mask references will move together so the visible artwork, masking, and desktop layout keep the same geometry.

The existing WebP title, avatar, converted illustrations, and display font will use content-fingerprinted filenames. The title keeps its existing desktop resolution to avoid softening high-DPI desktop displays. Fingerprinted assets will receive a one-year immutable cache policy; unversioned assets retain the existing conservative policy. This prevents stale artwork after deploys while resolving the short-cache audit for the assets identified by Lighthouse.

The mascot `<img>` will receive `fetchpriority="high"`. It remains directly discoverable in the initial HTML and will not be lazy-loaded.

## Metadata

The document will declare English with `<html lang="en">`, add a concise description of the game, and declare `https://boombeard.co.za/` as the canonical URL. These changes do not affect visual layout.

## Explicitly Deferred Work

This pass will not:

- add a bundler, minifier, or transpiler;
- split or remove CSS or JavaScript;
- defer the game's module graph;
- change the menu visualizer or its animation/reflow behavior;
- change CSP to nonces or Trusted Types;
- enable HSTS preload, `includeSubDomains`, or COOP;
- change desktop layout or introduce mobile behavior.

Those items require broader architectural or visual validation and are disproportionate to a site already scoring 94 for desktop performance with 40 ms total blocking time and zero layout shift.

## Verification

Automated tests will verify:

- eligible text responses are gzipped and can be decompressed to the original bytes;
- clients without gzip support receive the original response;
- byte-range responses are never compressed;
- compressed responses vary on `Accept-Encoding`;
- content-fingerprinted assets receive immutable caching while ordinary assets do not;
- every changed image and font reference resolves to a file;
- the mascot is high priority and not lazy-loaded;
- language, description, and canonical metadata are present;
- converted images preserve their source dimensions;
- the full project test suite remains green.

After deployment, live headers and transfer sizes will be checked directly. A new desktop Lighthouse run can then measure the score impact; exact Lighthouse scores are not asserted because they vary with throttling and run conditions.
