// ==UserScript==
// @name         Movie Madness Availability for Letterboxd
// @namespace    https://letterboxd.com
// @version      1.0.0
// @description  Shows Movie Madness Portland rental availability on Letterboxd film pages
// @author       Travis Sanders
// @match        https://letterboxd.com/film/*
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

    // Patterns to detect format from title strings like "HELLRAISER (BLU-RAY)" or "JENNIFER'S BODY (BLU RAY)"
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

    // -------------------------------------------------------------------------
    // Title helpers
    // -------------------------------------------------------------------------

    function getFilmInfo() {
        let title = null;
        let year  = null;

        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) {
            const content = ogTitle.getAttribute('content') || '';
            const m = content.match(/^(.*?)\s*\((\d{4})\)\s*$/);
            if (m) {
                title = m[1].trim();
                year  = m[2];
            } else {
                title = content.trim();
            }
        }

        if (!title) {
            title = document.querySelector('h1')?.textContent.trim() ?? null;
        }

        if (!year) {
            const yearLink = document.querySelector('a[href*="/films/year/"]');
            year = yearLink?.textContent.trim() ?? null;
        }

        return { title, year };
    }

    // Normalise to bare lowercase words for fuzzy matching.
    // Handles MovieMadness "TITLE, THE" <-> Letterboxd "The Title" convention.
    function normalizeForMatch(str) {
        return str
            .toLowerCase()
            .replace(/,\s*(the|a|an)\s*$/i, '') // strip trailing article ("GODFATHER, THE")
            .replace(/^(the|a|an)\s+/i, '')      // strip leading article  ("The Godfather")
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Strip all parenthetical content from an MM title string.
    // MM titles are like "HELLRAISER (BLU-RAY)" or "JENNIFER'S BODY (UNRATED)(DVD)"
    // or occasionally "GODFATHER, THE (1972) (DVD)" — all of it gets stripped.
    function mmTitleBase(mmTitle) {
        return mmTitle.replace(/\s*\([^)]*\)/g, '').trim();
    }

    function titlesMatch(searchTitle, mmTitle) {
        return normalizeForMatch(searchTitle) === normalizeForMatch(mmTitleBase(mmTitle));
    }

    // -------------------------------------------------------------------------
    // Parse MovieMadness search results HTML
    // -------------------------------------------------------------------------

    // MM location strings concatenate section + subsection without a separator:
    // "Leviathans & BehemothsGODZILLA" → "Leviathans & Behemoths > GODZILLA"
    // The boundary is always a lowercase letter immediately followed by an uppercase one.
    function formatLocation(loc) {
        return loc.replace(/([a-z])([A-Z])/, '$1 > $2');
    }

    // Returns { formats: Set<string>, location: string|null }
    function parseSearchResults(html, title, year) {
        const parser = new DOMParser();
        const doc    = parser.parseFromString(html, 'text/html');
        const found  = new Set();
        let location = null;

        // MM titles are in headings like:
        //   "HELLRAISER (BLU-RAY)"
        //   "JENNIFER'S BODY (UNRATED)(DVD)"
        //   "GODFATHER, THE (1972) (DVD)"
        // We strip all parentheticals to get the base title, then match.
        doc.querySelectorAll('h1, h2, h3, h4, h5').forEach(el => {
            const text = el.textContent.trim();
            if (!text) return;

            // If both sides have a year, allow ±1 tolerance — databases often
            // disagree by one year for films with late or multi-country releases.
            if (year) {
                const elYear = text.match(/\((\d{4})\)/)?.[1];
                if (elYear && Math.abs(Number(elYear) - Number(year)) > 1) return;
            }

            if (!titlesMatch(title, text)) return;

            FORMAT_PATTERNS.forEach(({ re, label }) => {
                if (re.test(text)) found.add(label);
            });

            // Extract location from the card container of the first match.
            if (location !== null) return;
            const card = el.closest('article, section, li') ?? el.parentElement?.parentElement ?? el.parentElement;
            if (!card) return;

            // Look for an element whose text starts with "MM LOCATION"
            for (const child of card.querySelectorAll('*')) {
                const t = child.textContent.trim();
                if (!t.startsWith('MM LOCATION')) continue;

                // Value may be in the same element after the label, or in a sibling.
                const inlineMatch = t.match(/MM LOCATION[:\s]+(.+)/);
                if (inlineMatch) {
                    location = formatLocation(inlineMatch[1].trim());
                    break;
                }
                const next = child.nextElementSibling;
                if (next) {
                    location = formatLocation(next.textContent.trim());
                    break;
                }
            }
        });

        return { formats: found, location };
    }

    // -------------------------------------------------------------------------
    // Build the UI widget
    // -------------------------------------------------------------------------

    function buildWidget(formats, location, searchUrl) {
        const widget = document.createElement('section');
        widget.id = 'mm-availability';
        widget.style.cssText = [
            'margin: 1.2em 0',
            'padding: 0.7em 1em',
            'background: rgba(255,255,255,0.05)',
            'border-left: 3px solid #e9b84a',
            'border-radius: 3px',
            'font-size: 0.85em',
            'line-height: 1.4',
        ].join(';');

        // Header row
        const header = document.createElement('p');
        header.style.cssText = 'margin:0 0 0.5em; display:flex; align-items:center; gap:0.4em;';

        const favicon = document.createElement('img');
        favicon.src    = `${MM_BASE}/wp-content/uploads/2024/09/cropped-MM-favicon-32x32.png`;
        favicon.width  = 16;
        favicon.height = 16;
        favicon.style.cssText = 'display:block; flex-shrink:0;';

        const mmLabel = document.createElement('span');
        mmLabel.textContent = 'Movie Madness';
        mmLabel.style.cssText = 'color:#e9b84a; font-weight:600;';

        header.appendChild(favicon);
        header.appendChild(mmLabel);
        widget.appendChild(header);

        if (formats.size === 0) {
            const msg = document.createElement('p');
            msg.style.cssText = 'margin:0; color:#567;';
            msg.textContent = 'Not found in collection';
            widget.appendChild(msg);
        } else {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; gap:0.4em; flex-wrap:wrap;';

            FORMAT_ORDER.forEach(fmt => {
                if (!formats.has(fmt)) return;
                const badge = document.createElement('a');
                badge.href   = searchUrl;
                badge.target = '_blank';
                badge.rel    = 'noopener noreferrer';
                badge.textContent = fmt;
                badge.title  = `Rent ${fmt} at Movie Madness`;
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
                badge.addEventListener('mouseover', () => { badge.style.opacity = '0.8'; });
                badge.addEventListener('mouseout',  () => { badge.style.opacity = '1'; });
                row.appendChild(badge);
            });

            widget.appendChild(row);

            if (location) {
                const loc = document.createElement('p');
                loc.textContent = location;
                loc.style.cssText = 'margin:0.5em 0 0; font-size:0.85em; color:#678;';
                widget.appendChild(loc);
            }
        }

        return widget;
    }

    // -------------------------------------------------------------------------
    // Inject widget into Letterboxd page
    // -------------------------------------------------------------------------

    // Watches for `primary` selector to appear via MutationObserver.
    // If it hasn't appeared after `timeoutMs`, falls back to the first match
    // in `fallbacks`. Calls `cb` with whichever element is found.
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

    // -------------------------------------------------------------------------
    // Main
    // -------------------------------------------------------------------------

    function run() {
        const { title, year } = getFilmInfo();
        if (!title) return;

        const searchUrl = `${MM_BASE}/search/?query=${encodeURIComponent(title)}`;

        // Fetch MovieMadness in parallel while waiting for the DOM target
        let fetchedWidget = null;
        let anchor        = null;

        function tryInject() {
            if (!fetchedWidget || !anchor) return;
            anchor.insertAdjacentElement('afterend', fetchedWidget);
        }

        // Kick off the network request immediately
        GM_xmlhttpRequest({
            method: 'GET',
            url:    searchUrl,
            onload(response) {
                try {
                    const { formats, location } = parseSearchResults(response.responseText, title, year);
                    fetchedWidget = buildWidget(formats, location, searchUrl);
                } catch (e) {
                    fetchedWidget = null;
                }
                tryInject();
            },
            onerror() {
                // nothing to inject
            },
        });

        // #watch > section exists when streaming options are listed.
        // For films with no streaming options it never appears, so fall back
        // to #watch or section.watch-panel after a 5-second timeout.
        waitForElement('#watch > section', ['#watch', 'section.watch-panel'], 5000, el => {
            anchor = el;
            tryInject();
        });
    }

    run();
})();
