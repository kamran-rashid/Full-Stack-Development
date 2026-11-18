/* =====================================================================
   FinTrack Lab 3 - js/motion.js
   The small amount of JavaScript the visual refresh needs. All scroll
   effects themselves are CSS (styles.css section 15); this file only:

     1. wraps words in <span class="w"> so CSS can light them one by one
     2. plays the opening film only when motion is welcome, pauses it when
        it is off screen, and gives the user a pause / play button
     3. switches the top bar to "glass" while it sits over the film
     4. marks the chapter in view in the top bar (scroll-spy)

   It uses no scroll listeners: IntersectionObserver tells it when things
   enter or leave the screen, which costs nothing while scrolling.
===================================================================== */
"use strict";

(function () {
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const scrollTimelines = window.CSS?.supports?.("animation-timeline: view()") ?? false;

    /* ---------- 1. words that light up as you scroll ----------
       Only text nodes are split, so links and <mark> highlights inside the
       paragraph keep working. Spaces stay as plain text, so screen readers
       and copy-paste read the paragraph exactly as before. */
    function splitWords(el) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);

        let index = 0;
        for (const node of textNodes) {
            const parts = node.textContent.split(/(\s+)/);
            const fragment = document.createDocumentFragment();
            for (const part of parts) {
                if (!part) continue;
                if (/^\s+$/.test(part)) { fragment.append(part); continue; }
                const span = document.createElement("span");
                span.className = "w";
                span.style.setProperty("--i", index++);
                span.textContent = part;
                fragment.append(span);
            }
            node.replaceWith(fragment);
        }
        // data-scroll-words="contain 4 48" means: on this element's timeline, light the
        // words one after another between 4% and 48% of the "contain" range.
        // (Chrome will not compute var() inside animation-range, so each word gets its slice here.)
        const [range = "cover", from = "20", to = "60"] = (el.dataset.scrollWords || "").split(/\s+/);
        const a = Number(from), b = Number(to);
        el.querySelectorAll(".w").forEach((word, i) => {
            const start = a + ((b - a) * i) / index;
            const end = a + ((b - a) * (i + 1)) / index;
            word.style.animationRange = `${range} ${start.toFixed(2)}% ${range} ${end.toFixed(2)}%`;
        });
        el.classList.add("is-split");
    }

    if (scrollTimelines && !reduceMotion.matches) document.querySelectorAll("[data-scroll-words]").forEach(splitWords);


    /* ---------- the film sits under the top bar: CSS needs the bar's real height ---------- */
    const bar = document.querySelector(".topbar");
    if (bar) {
        new ResizeObserver(() => {
            document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
        }).observe(bar);
    }


    /* ---------- 2. the opening film ---------- */
    const video = document.querySelector(".opening-video");
    const toggle = document.querySelector(".film-toggle");
    let pausedByUser = false;
    let onScreen = true;

    function saveData() {
        return navigator.connection?.saveData === true;
    }

    function shouldPlay() {
        return !pausedByUser && onScreen && !reduceMotion.matches && !saveData() && !document.hidden;
    }

    function updateFilm() {
        if (!video) return;
        if (shouldPlay()) {
            // play() returns a promise that rejects if the browser blocks autoplay: the poster stays, which is fine
            video.play().catch(() => {});
        } else {
            video.pause();
        }
        if (toggle) {
            const paused = video.paused || !shouldPlay();
            toggle.setAttribute("aria-pressed", String(paused));
            toggle.querySelector(".vh").textContent = paused ? "Play the background film" : "Pause the background film";
        }
    }

    if (video) {
        if (toggle && !reduceMotion.matches && !saveData()) {
            toggle.hidden = false;
            toggle.addEventListener("click", () => {
                pausedByUser = !pausedByUser;
                updateFilm();
            });
        }
        // no need to decode video frames nobody can see
        new IntersectionObserver(([entry]) => {
            onScreen = entry.isIntersecting;
            updateFilm();
        }).observe(video);
        reduceMotion.addEventListener("change", updateFilm);
        document.addEventListener("visibilitychange", updateFilm);
        video.addEventListener("play", () => toggle && toggle.setAttribute("aria-pressed", "false"));
        updateFilm();
    }


    /* ---------- 3. glass top bar over the film ----------
       A thin invisible marker covers the dark part of the opening (styles.css 15a).
       While it is under the top bar, the bar turns to dark glass. */
    const sentinel = document.querySelector(".film-sentinel");
    if (sentinel) {
        new IntersectionObserver(([entry]) => {
            document.documentElement.classList.toggle("on-film", entry.isIntersecting);
        }, { rootMargin: "0px 0px -92% 0px" }).observe(sentinel);
    }


    /* ---------- 4. scroll-spy: which chapter is in view ---------- */
    const links = new Map(
        [...document.querySelectorAll(".topbar a.nav-link")]
            .map((link) => [link.getAttribute("href").slice(1), link])
    );
    const chapters = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);

    // a chapter counts as "in view" when it crosses a thin line 40% down the screen
    const spy = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            links.forEach((link, id) => {
                if (id === entry.target.id) link.setAttribute("aria-current", "true");
                else link.removeAttribute("aria-current");
            });
        }
    }, { rootMargin: "-40% 0px -59% 0px" });
    chapters.forEach((chapter) => spy.observe(chapter));
})();
