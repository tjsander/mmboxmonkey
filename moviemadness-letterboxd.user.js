// ==UserScript==
// @name         Movie Madness Availability for Letterboxd
// @namespace    https://letterboxd.com
// @version      1.2.0
// @description  Shows Movie Madness Portland rental availability on Letterboxd film pages
// @author       Travis Sanders
// @match        https://letterboxd.com/film/*
// @match        https://letterboxd.com/*/film/*
// @homepageURL  https://github.com/tjsander/mmboxmonkey
// @downloadURL  https://github.com/tjsander/mmboxmonkey/raw/main/moviemadness-letterboxd.user.js
// @updateURL    https://github.com/tjsander/mmboxmonkey/raw/main/moviemadness-letterboxd.user.js
// @grant        GM_xmlhttpRequest
// @connect      moviemadness.org
// @connect      tjsander.github.io
// ==/UserScript==

(function () {
    'use strict';

    const MM_BASE = 'https://www.moviemadness.org';

    // MM search pages hold 12 results. Title matches cluster at the top, so a
    // few pages is plenty; the cap bounds requests for very common titles.
    const PAGE_SIZE = 12;
    const MAX_PAGES = 5;

    // Movie Madness rentals by TMDB id, as static files rebuilt once a day:
    // https://github.com/tjsander/movie-madness-pdx-tmdb. An id's rentals are
    // under its key in tmdb/<movie|tv>/<id % 1000, three digits>.json.
    const API_BASE   = 'https://tjsander.github.io/movie-madness-pdx-tmdb';
    const API_SHARDS = 1000;

    const FORMAT_ORDER = ['4K UHD', 'Blu-Ray 3D', 'Blu-Ray', 'DVD', 'DVD-R', 'VHS'];

    // MM title strings use e.g. "(BLU RAY)" and "(BLU-RAY)" interchangeably.
    const FORMAT_PATTERNS = [
        { re: /\(4K\s*UHD(?:[\s-]?BLU[\s-]?RAY)?\)/i, label: '4K UHD' },
        { re: /\(BLU[\s-]?RAY\)/i,                     label: 'Blu-Ray' },
        { re: /\(DVD\)/i,                               label: 'DVD' },
        { re: /\(VHS\)/i,                               label: 'VHS' },
    ];

    const FORMAT_COLORS = {
        '4K UHD':     '#e8832a',
        'Blu-Ray 3D': '#4c9be8',
        'Blu-Ray':    '#4c9be8',
        'DVD':        '#67c267',
        'DVD-R':      '#67c267',
        'VHS':        '#c8a84b',
    };

    const TMDB_LINK = /themoviedb\.org\/(movie|tv)\/([1-9]\d*)/;

    // Film pages link to the film's TMDB page in their footer; Letterboxd is
    // built on TMDB, so every film has one. The <body> data-tmdb-* attributes
    // are not used: for shows they can name a different entry than the link
    // does (Dekalog), and the link is the right one.
    // Returns { kind: 'movie'|'tv', id: number } or null.
    function getTmdb() {
        const link = document.querySelector('a[href*="themoviedb.org/movie/"], a[href*="themoviedb.org/tv/"]');
        const m = link?.getAttribute('href').match(TMDB_LINK);
        return m ? { kind: m[1], id: Number(m[2]) } : null;
    }

    // Review and diary pages (/<member>/film/<slug>/) carry no TMDB id, so read
    // it from the film's own page: one request to Letterboxd, far quicker than
    // searching the store. Calls back with getTmdb()'s result or null.
    function findTmdb(cb) {
        const here = getTmdb();
        const slug = document.location.pathname.match(/^\/[^/]+\/film\/([^/]+)\//)?.[1];
        if (here || !slug) { cb(here); return; }

        fetch(`${document.location.origin}/film/${slug}/`)
            .then(response => (response.ok ? response.text() : ''))
            .then(html => {
                const m = html.match(TMDB_LINK);
                cb(m ? { kind: m[1], id: Number(m[2]) } : null);
            })
            .catch(() => cb(null));
    }

    // The store has no page for a single rental worth linking to: details open
    // in a pop-up that an address can't trigger, and the bare ?rental=<slug>
    // page often carries another film's name in its address. A search for the
    // store's own full title lists just that rental; without the edition and
    // format it lists every edition from that year. The store cuts long titles
    // off mid-parenthesis, so an unclosed one is dropped.
    function rentalSearchUrl(mmTitle, allEditions) {
        let query = mmTitle.replace(/\s*\([^)]*$/, '');
        if (allEditions) query = query.replace(/\s*\((?!\d{4}\))[^)]*\)/g, '');
        return `${MM_BASE}/search/?query=${encodeURIComponent(toSearchQuery(query))}`;
    }

    // Turns the lookup files' rentals for one TMDB id into what the widget
    // shows. Each badge links to a search for its rental, or for every edition
    // when the format is held in several. `shelf` is the permanent shelf and
    // `display` a temporary one (New Arrival, Staff Picks).
    // Returns { formats: Set<string>, locations: string[], links: {format: url} }.
    function fromRentals(rentals) {
        const formats = new Set();
        const links   = {};
        const places  = new Map();

        rentals.forEach(r => {
            if (!FORMAT_COLORS[r.format]) return;
            links[r.format] = rentalSearchUrl(r.title, formats.has(r.format));
            formats.add(r.format);

            const place = [r.display, r.shelf].filter(Boolean).join(' · ');
            if (!place) return;
            if (!places.has(place)) places.set(place, new Set());
            places.get(place).add(r.format);
        });

        const locations = places.size === 1
            ? [...places.keys()]
            : [...places].map(([place, held]) =>
                `${FORMAT_ORDER.filter(f => held.has(f)).join(', ')}: ${place}`);

        return { formats, locations, links };
    }

    function getFilmInfo() {
        let content = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';

        // User review pages have og:title like "Travis's review of Lynch/Oz (2022)";
        // logs without review text read "A ★★★½ diary entry for Lifeforce (1985)".
        const reviewOf = content.match(/\b(?:review of|diary entry for) (.+)$/i);
        if (reviewOf) content = reviewOf[1];

        const m = content.match(/^(.*?)\s*\((\d{4})\)\s*$/);
        let title = m ? m[1].trim() : (content.trim() || null);
        let year  = m ? m[2] : null;

        if (!title) title = document.querySelector('h1')?.textContent.trim() ?? null;
        if (!year)  year  = document.querySelector('a[href*="/films/year/"]')?.textContent.trim() ?? null;

        return { title, year, directors: getDirectors() };
    }

    // MM writes people as "BARKER, CLIVE", sometimes with a "**" marker or a
    // credit qualifier; Letterboxd writes "Clive Barker".
    function normalizePerson(name) {
        let n = name.toLowerCase().replace(/\*+/g, '').trim();
        n = n.replace(/\s*\([^)]*\)/g, '').replace(/,\s*$/, '').trim();
        const comma = n.indexOf(',');
        if (comma !== -1) n = `${n.slice(comma + 1).trim()} ${n.slice(0, comma).trim()}`;
        return n.replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    }

    // The two sites abbreviate given names differently ("ANDERSON, P.T." vs
    // "Paul Thomas Anderson"), so compare on surname plus first initial. Titles
    // and years are already known to match by the time this is used, which keeps
    // same-surname collisions from mattering in practice.
    function personKey(name) {
        const parts = normalizePerson(name).split(' ').filter(Boolean);
        if (!parts.length) return '';
        const last = parts.pop();
        return `${last}|${parts.length ? parts[0][0] : ''}`;
    }

    // Letterboxd credits directors as /director/<slug> links (listed twice, as a
    // full and a short label, so a Set dedupes). Falls back to the page's
    // schema.org block, which is wrapped in CDATA comments. Review pages have no
    // director links and nest the film under itemReviewed.
    // Returns a Set of personKey() values.
    function getDirectors() {
        const names = new Set();

        document.querySelectorAll('a[href^="/director/"]').forEach(a => {
            const key = personKey(a.textContent);
            if (key) names.add(key);
        });
        if (names.size) return names;

        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const data = JSON.parse(script.textContent.replace(/\/\*[\s\S]*?\*\//g, ''));
                (data.itemReviewed?.director ?? data.director ?? []).forEach(d => {
                    const key = personKey(d.name ?? '');
                    if (key) names.add(key);
                });
            } catch (e) { /* not the block we're after */ }
            if (names.size) break;
        }

        return names;
    }

    // Databases disagree on Roman vs Arabic sequel numbers (e.g. "III" vs "3").
    // Applied after lowercasing so we match on the lowercase forms.
    const ROMAN_NUMERALS = [
        [/\bxiii\b/g, '13'], [/\bxii\b/g, '12'], [/\bxi\b/g, '11'],
        [/\bix\b/g,   '9'],  [/\bviii\b/g, '8'], [/\bvii\b/g, '7'],
        [/\bvi\b/g,   '6'],  [/\biv\b/g,   '4'], [/\biii\b/g, '3'],
        [/\bii\b/g,   '2'],  [/\bx\b/g,   '10'], [/\bv\b/g,   '5'],
    ];

    // Handles MM "TITLE, THE" <-> Letterboxd "The Title" convention,
    // and Roman <-> Arabic numeral mismatches in sequel titles.
    function normalizeForMatch(str) {
        const s = str
            .toLowerCase()
            .replace(/,\s*(the|a|an)\s*$/i, '')
            .replace(/^(the|a|an)\s+/i, '')
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return ROMAN_NUMERALS.reduce((acc, [re, n]) => acc.replace(re, n), s);
    }

    // MM titles embed format and edition in parens: "HELLRAISER (BLU-RAY)",
    // "JENNIFER'S BODY (UNRATED)(DVD)", "GODFATHER, THE (1972) (DVD)".
    function mmTitleBase(mmTitle) {
        return mmTitle.replace(/\s*\([^)]*\)/g, '').trim();
    }

    // MM numbers sequels that Letterboxd leaves unnumbered: "JAWS 4: THE REVENGE"
    // vs "Jaws: The Revenge", "HELLRAISER 5: INFERNO" vs "Hellraiser: Inferno".
    // The number is only dropped when it sits directly before the subtitle colon,
    // so "JAWS 4" still won't match "Jaws".
    function dropSequelNumber(base) {
        return base.replace(/^(.+?)\s+\d+\s*:/, '$1:');
    }

    function titlesMatch(searchTitle, mmTitle) {
        const norm = normalizeForMatch(searchTitle);
        const base = mmTitleBase(mmTitle);
        const variants = [
            base,
            // MM appends "THE MOVIE" to stage-show adaptations (e.g. "MAMMA MIA! THE MOVIE").
            base.replace(/\bthe movie\b\s*$/i, '').trim(),
            dropSequelNumber(base),
        ];
        return variants.some(variant => normalizeForMatch(variant) === norm);
    }

    // Prepare a title for use as a MovieMadness search query.
    // Converts Roman numerals (III → 3) and strips punctuation that breaks
    // MM search (colons cause zero results for e.g. "The Lost World: Jurassic Park").
    function toSearchQuery(title) {
        return ROMAN_NUMERALS
            .reduce((acc, [re, n]) => acc.replace(new RegExp(re.source, 'gi'), n), title)
            .replace(/[:'"""!?]/g, '')
            .trim();
    }

    // MM location strings concatenate section + subsection without a separator:
    // "Leviathans & BehemothsGODZILLA" → "Leviathans & Behemoths > GODZILLA"
    function formatLocation(loc) {
        return loc.replace(/([a-z])([A-Z])/g, '$1 > $2');
    }

    // MM's detail dialog lists crew as a flat run of spans:
    // <span>Clive Barker</span><span>(Director), </span><span>Christopher Figg</span>...
    // These names come from TMDB and are the most reliable signal MM exposes.
    function crewDirectors(card) {
        const out = [];
        card.querySelectorAll('span').forEach(label => {
            if (label.textContent.trim() !== 'Crew:') return;
            const list = label.nextElementSibling;
            if (!list) return;
            const spans = [...list.querySelectorAll('span')];
            spans.forEach((span, i) => {
                if (i > 0 && /^\(Director\)/i.test(span.textContent.trim())) {
                    out.push(spans[i - 1].textContent);
                }
            });
        });
        return out;
    }

    // MM's own catalog "Director:" field. Unlike the TMDB crew list it often
    // credits the writer instead ("KING, STEPHEN (WRITTEN BY)"), so only trust
    // it when the credit carries no qualifier.
    function declaredDirector(card) {
        for (const label of card.querySelectorAll('span')) {
            if (label.textContent.trim() !== 'Director:') continue;
            const holder = label.nextElementSibling;
            if (!holder) continue;
            const raw = holder.textContent.replace(/\*+/g, '').trim();
            return raw.includes('(') ? null : raw;
        }
        return null;
    }

    // MM puts the year either in the title ("BLOB, THE (1988) (DVD)") or in a
    // badge on the card. Edition parens never hold a bare 4-digit number.
    function cardYear(card, mmTitle) {
        const inTitle = mmTitle.match(/\((\d{4})\)/);
        if (inTitle) return Number(inTitle[1]);
        for (const el of card.querySelectorAll('span')) {
            const t = el.textContent.trim();
            if (/^(?:19|20)\d{2}$/.test(t)) return Number(t);
        }
        return null;
    }

    // MM's catalog is TMDB-sourced but exposes no TMDB or IMDb id anywhere, so
    // identity has to be confirmed from the director credit. Tiers run from most
    // to least reliable; entries carrying no director at all (~1 in 5 of the
    // catalog is not TMDB-enriched) fall back to an exact year match.
    function identityMatches(card, mmYear, film) {
        if (!film.directors.size) return true;   // nothing to check against

        const crew = crewDirectors(card).map(personKey).filter(Boolean);
        if (crew.length) return crew.some(key => film.directors.has(key));

        const declared = declaredDirector(card);
        if (declared) {
            const key = personKey(declared);
            if (key) return film.directors.has(key);
        }

        return Boolean(film.year && mmYear && Number(film.year) === mmYear);
    }

    function collectFormats(card, mmTitle, found) {
        FORMAT_PATTERNS.forEach(({ re, label }) => {
            if (re.test(mmTitle)) found.add(label);
        });

        // Some entries have no format in the title (e.g. "JEEPERS CREEPERS 2
        // (COLLECTORS EDITION)") — fall back to bare format badges in the card.
        card.querySelectorAll('*').forEach(child => {
            if (child.children.length > 0) return;
            const t = child.textContent.trim();
            if (/^DVD$/i.test(t))               found.add('DVD');
            else if (/^VHS$/i.test(t))          found.add('VHS');
            else if (/^BLU[\s-]?RAY$/i.test(t)) found.add('Blu-Ray');
            else if (/^4K\s*UHD$/i.test(t))     found.add('4K UHD');
        });
    }

    function cardLocation(card) {
        for (const child of card.querySelectorAll('*')) {
            const t = child.textContent.trim();
            if (!t.startsWith('MM LOCATION')) continue;
            const inlineMatch = t.match(/MM LOCATION[:\s]+(.+)/);
            if (inlineMatch) return formatLocation(inlineMatch[1].trim());
            if (child.nextElementSibling) {
                return formatLocation(child.nextElementSibling.textContent.trim());
            }
            return null;
        }
        return null;
    }

    // Returns { formats: Set<string>, location: string|null, titleMatches: number,
    // hasMore: boolean } for one page of search results.
    function parseSearchResults(html, film) {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(html, 'text/html');
        const found  = new Set();
        let location = null;
        let titleMatches = 0;

        // Each result is one [data-mmdb-id] block holding the card and its
        // detail dialog.
        const cards = doc.querySelectorAll('[data-mmdb-id]');

        cards.forEach(card => {
            const mmTitle = card.querySelector('h3')?.textContent.trim();
            if (!mmTitle || !titlesMatch(film.title, mmTitle)) return;
            titleMatches++;

            // Allow ±1 year tolerance — databases often disagree for films with
            // late or multi-country releases (e.g. Casablanca: 1942 vs 1943).
            const mmYear = cardYear(card, mmTitle);
            if (film.year && mmYear && Math.abs(mmYear - Number(film.year)) > 1) return;

            if (!identityMatches(card, mmYear, film)) return;

            collectFormats(card, mmTitle, found);
            if (location === null) location = cardLocation(card);
        });

        // MM loads the next page on scroll via an htmx "?offset=N" trigger,
        // present only while more results remain.
        const hasMore = Boolean(doc.querySelector('[hx-get*="offset="]'));

        return { formats: found, location, titleMatches, hasMore };
    }

    // The box and its "Movie Madness" header, which every state shares.
    function buildFrame() {
        if (!document.getElementById('mm-availability-style')) {
            const style = document.createElement('style');
            style.id = 'mm-availability-style';
            style.textContent = [
                '#mm-availability a.mm-badge:hover { opacity: 0.8; }',
                '@keyframes mm-reel { to { transform: rotate(360deg); } }',
                '#mm-availability .mm-reel { animation: mm-reel 1.6s linear infinite; }',
                '@media (prefers-reduced-motion: reduce) { #mm-availability .mm-reel { animation: none; } }',
            ].join('\n');
            document.head.appendChild(style);
        }

        const widget = document.createElement('section');
        widget.id = 'mm-availability';
        widget.style.cssText = [
            'margin:1.2em 0',
            'padding:0.7em 1em',
            'background:rgba(255,255,255,0.05)',
            'border-left:3px solid #e9b84a',
            'border-radius:3px',
            'font-size:0.85em',
            'line-height:1.4',
        ].join(';');

        const header = document.createElement('p');
        header.style.cssText = 'margin:0 0 0.5em;display:flex;align-items:center;gap:0.4em;';

        const favicon = document.createElement('img');
        favicon.src    = `${MM_BASE}/wp-content/uploads/2024/09/cropped-MM-favicon-32x32.png`;
        favicon.width  = 16;
        favicon.height = 16;
        favicon.style.cssText = 'display:block;flex-shrink:0;';

        const mmLabel = document.createElement('span');
        mmLabel.textContent = 'Movie Madness';
        mmLabel.style.cssText = 'color:#e9b84a;font-weight:600;';

        header.appendChild(favicon);
        header.appendChild(mmLabel);
        widget.appendChild(header);
        return widget;
    }

    // Shown while the answer is on its way: a turning film reel.
    function buildLoading() {
        const SVG = 'http://www.w3.org/2000/svg';
        const shape = (name, attrs) => {
            const el = document.createElementNS(SVG, name);
            Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
            return el;
        };

        const reel = shape('svg', { viewBox: '0 0 24 24', width: 18, height: 18, class: 'mm-reel', 'aria-hidden': 'true' });
        reel.style.cssText = 'display:block;flex-shrink:0;';
        reel.appendChild(shape('circle', { cx: 12, cy: 12, r: 10.5, fill: 'none', stroke: '#e9b84a', 'stroke-width': 1.5 }));
        reel.appendChild(shape('circle', { cx: 12, cy: 12, r: 1.5, fill: '#e9b84a' }));
        for (let i = 0; i < 5; i++) {
            const angle = (i * 2 * Math.PI) / 5;
            reel.appendChild(shape('circle', {
                cx: (12 + 6 * Math.sin(angle)).toFixed(2),
                cy: (12 - 6 * Math.cos(angle)).toFixed(2),
                r: 2.2, fill: '#e9b84a',
            }));
        }

        const text = document.createElement('span');
        text.textContent = 'Checking the collection…';

        const row = document.createElement('p');
        row.setAttribute('role', 'status');
        row.style.cssText = 'margin:0;display:flex;align-items:center;gap:0.5em;color:#678;';
        row.appendChild(reel);
        row.appendChild(text);

        const widget = buildFrame();
        widget.appendChild(row);
        return widget;
    }

    // `emptyText` is what the search link reads when there are no formats.
    function buildWidget(formats, locations, searchUrl, links = {}, emptyText = 'Not found in collection') {
        const widget = buildFrame();

        if (formats.size === 0) {
            const msg = document.createElement('p');
            msg.style.cssText = 'margin:0;';
            const link = document.createElement('a');
            link.href = searchUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = emptyText;
            link.style.cssText = 'color:#567;';
            msg.appendChild(link);
            widget.appendChild(msg);
        } else {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:0.4em;flex-wrap:wrap;';

            FORMAT_ORDER.forEach(fmt => {
                if (!formats.has(fmt)) return;
                const badge = document.createElement('a');
                badge.className = 'mm-badge';
                badge.href      = links[fmt] ?? searchUrl;
                badge.target    = '_blank';
                badge.rel       = 'noopener noreferrer';
                badge.textContent = fmt;
                badge.title     = `Rent ${fmt} at Movie Madness`;
                badge.style.cssText = [
                    `background:${FORMAT_COLORS[fmt]}`,
                    'color:#fff',
                    'padding:0.2em 0.55em',
                    'border-radius:3px',
                    'font-size:0.9em',
                    'font-weight:600',
                    'text-decoration:none',
                    'white-space:nowrap',
                ].join(';');
                row.appendChild(badge);
            });

            widget.appendChild(row);

            locations.forEach((location, i) => {
                const loc = document.createElement('p');
                loc.textContent = location;
                // Editions shelved apart: a faint rule between the shelves.
                const rule = i ? 'padding-top:0.5em;border-top:1px solid rgba(255,255,255,0.1);' : '';
                loc.style.cssText = `margin:0.5em 0 0;font-size:0.85em;color:#678;${rule}`;
                widget.appendChild(loc);
            });
        }

        return widget;
    }

    // Puts the widget in the "Where to watch" panel. The page arrives with an
    // empty #watch; Letterboxd fills it with a <section> of streaming services a
    // moment later, or never for films with none. The widget goes right after
    // #watch until that section exists, then right after the section, so it
    // never waits on Letterboxd's own request. Review pages load the whole
    // panel later, into a placeholder under the poster; until then the widget
    // goes after the placeholder.
    function place(widget) {
        const after = document.querySelector('#watch > section:not(#mm-availability)')
            ?? document.querySelector('#watch')
            ?? document.querySelector('section.watch-panel')
            ?? document.querySelector('[data-on-load="csi-availability"]');
        if (after && after.nextElementSibling !== widget) after.insertAdjacentElement('afterend', widget);
    }

    function run() {
        const film = getFilmInfo();
        if (!film.title) return;

        const searchUrl = `${MM_BASE}/search/?query=${encodeURIComponent(toSearchQuery(film.title))}`;
        const formats     = new Set();
        let location      = null;
        let widget        = null;

        function show(next) {
            if (widget) widget.remove();
            widget = next;
            place(widget);
        }

        // Nothing to say after the search itself failed with no formats found.
        function showUnreachable() {
            show(buildWidget(formats, [], searchUrl, {}, 'Couldn’t check; search Movie Madness'));
        }

        // Follow the panel while Letterboxd is still filling it in.
        const observer = new MutationObserver(() => { if (widget) place(widget); });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 15000);

        function searchFailed(page) {
            if (page === 0) showUnreachable();
            else show(buildWidget(formats, location ? [location] : [], searchUrl));
        }

        // MM returns results 12 at a time, best title matches first. Keep paging
        // while a page still holds title matches: other editions or a same-titled
        // film can land just past the first page (e.g. "HEAT, THE" at 22-23 for
        // "Heat"). A page with none ends the search.
        function fetchPage(page) {
            // The search takes seconds, so say it is under way. The lookup
            // files have answered by now (or there was no id to ask them
            // about), so a film they hold never shows this.
            if (page === 0) show(buildLoading());
            GM_xmlhttpRequest({
                method:  'GET',
                url:     page ? `${searchUrl}&offset=${page * PAGE_SIZE}` : searchUrl,
                timeout: 15000,
                onload(response) {
                    let result;
                    try {
                        result = parseSearchResults(response.responseText, film);
                    } catch (e) {
                        if (page === 0) { showUnreachable(); return; }
                    }
                    if (result) {
                        result.formats.forEach(f => formats.add(f));
                        location ??= result.location;
                    }

                    const more = Boolean(result?.hasMore && result.titleMatches && page + 1 < MAX_PAGES);
                    if (more) fetchPage(page + 1);

                    // Show badges as soon as there are any; hold "Not found"
                    // until the last page is in.
                    if (formats.size || !more) {
                        show(buildWidget(formats, location ? [location] : [], searchUrl));
                    }
                },
                onerror()   { searchFailed(page); },
                ontimeout() { searchFailed(page); },
            });
        }

        // The lookup files answer in one request and know the rental's TMDB id,
        // so there is nothing to match. They cover about three quarters of the
        // store's rentals, so a film they don't list may still be there under
        // a rental with no id: anything but a hit falls back to the search.
        function fetchByTmdb(tmdb) {
            const shard = String(tmdb.id % API_SHARDS).padStart(3, '0');
            GM_xmlhttpRequest({
                method:  'GET',
                url:     `${API_BASE}/tmdb/${tmdb.kind}/${shard}.json`,
                timeout: 8000,
                onload(response) {
                    let held;
                    try {
                        const rentals = JSON.parse(response.responseText)[tmdb.id];
                        if (Array.isArray(rentals)) held = fromRentals(rentals);
                    } catch (e) { /* not the file we expected */ }
                    if (!held?.formats.size) { fetchPage(0); return; }

                    show(buildWidget(held.formats, held.locations, searchUrl, held.links));
                },
                onerror()   { fetchPage(0); },
                ontimeout() { fetchPage(0); },
            });
        }

        findTmdb(tmdb => {
            if (tmdb) fetchByTmdb(tmdb);
            else fetchPage(0);
        });

    }

    run();
})();
