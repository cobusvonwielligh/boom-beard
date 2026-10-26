# Sitemap Design

## Goal

Make the public Boom Beard homepage discoverable through a standard XML sitemap at `https://boombeard.co.za/sitemap.xml`.

## Scope

- Add a static `public/sitemap.xml` containing only the canonical homepage URL, `https://boombeard.co.za/`.
- Add a static `public/robots.txt` that permits crawling and advertises the sitemap URL.
- Do not list `art-preview.html` or any server, deployment, health, or game transport endpoint.
- Do not add a `lastmod` value because there is no automated process that can keep it accurate.

## Architecture

Both files will live in `public/` and use the existing static-file server. No new server route, runtime dependency, build step, or deployment change is required.

The sitemap will use the sitemap protocol XML namespace. The robots file will contain a general user-agent rule and an absolute `Sitemap` directive.

## Error Handling

The existing static server will return its normal 404 response if either file is absent and its normal request error handling for malformed requests. The feature introduces no new runtime failure path.

## Verification

Automated tests will verify that:

- both files exist;
- the sitemap is well-formed for its simple static structure and contains exactly the canonical homepage URL;
- the robots file permits crawling and points to the canonical sitemap URL;
- the static server maps `.xml` and `.txt` to appropriate content types.

After deployment, `https://boombeard.co.za/sitemap.xml` and `https://boombeard.co.za/robots.txt` should both return HTTP 200.
