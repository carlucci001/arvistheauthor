# Arvis the Author — Site Scaffold

Standard static HTML site. No build step, no framework — open `index.html` in a browser or drop the folder on any static host.

## Structure

```
index.html        Home / launchpad (hero, featured books, bio teaser, email signup)
books.html        All titles, each with a Buy button
about.html        Full author bio
contact.html      Contact form (needs a form service to actually send)
css/styles.css    All styling; design tokens at the top of the file
js/main.js        Store link config, mobile nav, footer year, form handling
assets/images/    General images (author photo, etc.)
assets/covers/    Book cover images
```

## Yahoo store link — one place to set it

In `js/main.js`, set:

```js
const SITE_CONFIG = { storeUrl: "https://..." };
```

Every button/link with class `store-link` across the site picks it up. To send a specific book's Buy button to its exact product page, just give that link a real `href` instead of `#`.

## Dropping in the final design

- Colors, fonts, spacing: swap the CSS variables at the top of `css/styles.css` (`--color-*`, `--font-*`).
- Replace `.cover-placeholder` / `.portrait-placeholder` divs with `<img>` tags pointing at `assets/covers/` and `assets/images/`.
- Placeholder copy is marked clearly in each page — headlines, teasers, and bio paragraphs.

## Known TODOs

- [ ] Set `storeUrl` after the meeting (or swap to whatever platform is decided)
- [ ] Real book titles, descriptions, and cover images
- [ ] Author bio + photo
- [ ] Hook the contact + signup forms to a service (Formspree, store tooling, etc.)
- [ ] Favicon and social/OG meta tags once branding is final
