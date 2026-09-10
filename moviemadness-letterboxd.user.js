// ==UserScript==
// @name         Movie Madness Availability for Letterboxd
// @namespace    https://letterboxd.com
// @version      1.1.0
// @description  Shows Movie Madness Portland rental availability on Letterboxd film pages
// @author       Travis Sanders
// @match        https://letterboxd.com/film/*
// @match        https://letterboxd.com/*/film/*
// @homepageURL  https://github.com/tjsander/mmboxmonkey
// @downloadURL  https://github.com/tjsander/mmboxmonkey/raw/main/moviemadness-letterboxd.user.js
// @updateURL    https://github.com/tjsander/mmboxmonkey/raw/main/moviemadness-letterboxd.user.js
// @grant        GM_xmlhttpRequest
// @connect      moviemadness.org
// ==/UserScript==

(function () {
    'use strict';

    const MM_BASE = 'https://www.moviemadness.org';

    const FORMAT_ORDER = ['4K UHD', 'Blu-Ray', 'DVD', 'VHS'];

    // MM title strings use e.g. "(BLU RAY)" and "(BLU-RAY)" interchangeably.
    const FORMAT_PATTERNS = [
        { re: /\(4K\s*UHD(?:[\s-]?BLU[\s-]?RAY)?\)/i, label: '4K UHD' },
        { re: /\(BLU[\s-]?RAY\)/i,                     label: 'Blu-Ray' },
        { re: /\(DVD\)/i,                               label: 'DVD' },
        { re: /\(VHS\)/i,                               label: 'VHS' },
    ];

    const FORMAT_COLORS = {
        '4K UHD':  '#e8832a',
        'Blu-Ray': '#4c9be8',
        'DVD':     '#67c267',
        'VHS':     '#c8a84b',
    };

    function getFilmInfo() {
        let content = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';

        // User review pages have og:title like "Travis's review of Lynch/Oz (2022)".
        const reviewOf = content.match(/\breview of (.+)$/i);
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
    // schema.org block, which is wrapped in CDATA comments.
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
                (data.director ?? []).forEach(d => {
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

    function titlesMatch(searchTitle, mmTitle) {
        const norm = normalizeForMatch(searchTitle);
        const base = mmTitleBase(mmTitle);
        if (normalizeForMatch(base) === norm) return true;
        // MM appends "THE MOVIE" to stage-show adaptations (e.g. "MAMMA MIA! THE MOVIE").
        return normalizeForMatch(base.replace(/\bthe movie\b\s*$/i, '').trim()) === norm;
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

    // Returns { formats: Set<string>, location: string|null }
    function parseSearchResults(html, film) {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(html, 'text/html');
        const found  = new Set();
        let location = null;

        // Each result is one [data-mmdb-id] block holding the card and its
        // detail dialog. If MM changes that markup, fall back to the older
        // heading scan rather than silently reporting nothing.
        const cards = doc.querySelectorAll('[data-mmdb-id]');
        if (!cards.length) return parseSearchResultsByHeading(doc, film.title, film.year);

        cards.forEach(card => {
            const mmTitle = card.querySelector('h3')?.textContent.trim();
            if (!mmTitle || !titlesMatch(film.title, mmTitle)) return;

            // Allow ±1 year tolerance — databases often disagree for films with
            // late or multi-country releases (e.g. Casablanca: 1942 vs 1943).
            const mmYear = cardYear(card, mmTitle);
            if (film.year && mmYear && Math.abs(mmYear - Number(film.year)) > 1) return;

            if (!identityMatches(card, mmYear, film)) return;

            collectFormats(card, mmTitle, found);
            if (location === null) location = cardLocation(card);
        });

        return { formats: found, location };
    }

    // Legacy fallback: scan headings without identity verification.
    function parseSearchResultsByHeading(doc, title, year) {
        const found  = new Set();
        let location = null;

        doc.querySelectorAll('h1, h2, h3, h4, h5').forEach(el => {
            const text = el.textContent.trim();
            if (!text) return;

            // Allow ±1 year tolerance — databases often disagree for films with
            // late or multi-country releases (e.g. Casablanca: 1942 vs 1943).
            if (year) {
                const elYear = text.match(/\((\d{4})\)/)?.[1];
                if (elYear && Math.abs(Number(elYear) - Number(year)) > 1) return;
            }

            if (!titlesMatch(title, text)) return;

            FORMAT_PATTERNS.forEach(({ re, label }) => {
                if (re.test(text)) found.add(label);
            });

            const card = el.parentElement?.closest('article, section, li') ?? el.parentElement;

            // Some entries have no format in the heading (e.g. "JEEPERS CREEPERS 2
            // (COLLECTORS EDITION)") — fall back to bare format badges in the card.
            if (card) {
                card.querySelectorAll('*').forEach(child => {
                    if (child.children.length > 0) return;
                    const t = child.textContent.trim();
                    if (/^DVD$/i.test(t))           found.add('DVD');
                    else if (/^VHS$/i.test(t))      found.add('VHS');
                    else if (/^BLU[\s-]?RAY$/i.test(t)) found.add('Blu-Ray');
                    else if (/^4K\s*UHD$/i.test(t)) found.add('4K UHD');
                });
            }

            if (location !== null) return;
            if (!card) return;

            for (const child of card.querySelectorAll('*')) {
                const t = child.textContent.trim();
                if (!t.startsWith('MM LOCATION')) continue;
                const inlineMatch = t.match(/MM LOCATION[:\s]+(.+)/);
                if (inlineMatch) {
                    location = formatLocation(inlineMatch[1].trim());
                } else if (child.nextElementSibling) {
                    location = formatLocation(child.nextElementSibling.textContent.trim());
                }
                break;
            }
        });

        return { formats: found, location };
    }

    function buildWidget(formats, location, searchUrl) {
        const style = document.createElement('style');
        style.textContent = '#mm-availability a.mm-badge:hover { opacity: 0.8; }';
        document.head.appendChild(style);

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

        if (formats.size === 0) {
            const msg = document.createElement('p');
            msg.style.cssText = 'margin:0;';
            const link = document.createElement('a');
            link.href = searchUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Not found in collection';
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
                badge.href      = searchUrl;
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

            if (location) {
                const loc = document.createElement('p');
                loc.textContent = location;
                loc.style.cssText = 'margin:0.5em 0 0;font-size:0.85em;color:#678;';
                widget.appendChild(loc);
            }
        }

        return widget;
    }

    // Watches for `primary` to appear in the DOM; falls back to the first match
    // in `fallbacks` after `timeoutMs`. Only needed because the watch panel
    // renders dynamically and may be empty for films with no streaming options.
    function waitForElement(primary, fallbacks, timeoutMs, cb) {
        const existing = document.querySelector(primary);
        if (existing) { cb(existing); return; }

        let done = false;

        const observer = new MutationObserver(() => {
            if (done) return;
            const el = document.querySelector(primary);
            if (el) {
                done = true;
                observer.disconnect();
                clearTimeout(timer);
                cb(el);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            observer.disconnect();
            for (const sel of fallbacks) {
                const el = document.querySelector(sel);
                if (el) { cb(el); return; }
            }
        }, timeoutMs);
    }

    function run() {
        const film = getFilmInfo();
        if (!film.title) return;

        const searchUrl = `${MM_BASE}/search/?query=${encodeURIComponent(toSearchQuery(film.title))}`;
        let fetchedWidget = null;
        let anchor        = null;

        function tryInject() {
            if (!fetchedWidget || !anchor) return;
            anchor.insertAdjacentElement('afterend', fetchedWidget);
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url:    searchUrl,
            onload(response) {
                try {
                    const { formats, location } = parseSearchResults(response.responseText, film);
                    fetchedWidget = buildWidget(formats, location, searchUrl);
                } catch (e) {
                    fetchedWidget = null;
                }
                tryInject();
            },
            onerror() {},
        });

        // #watch > section exists when streaming options are listed; falls back
        // to #watch or section.watch-panel for films with no streaming options.
        waitForElement('#watch > section', ['#watch', 'section.watch-panel'], 5000, el => {
            anchor = el;
            tryInject();
        });
    }

    run();
})();
