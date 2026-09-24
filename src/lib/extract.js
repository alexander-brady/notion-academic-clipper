/**
 * The body of this function is serialised and injected into the page by
 * chrome.scripting.executeScript, so it must be completely self-contained:
 * no imports, no references to anything in this module's scope.
 */
export function extractPageMetadata() {
  const meta = (names) => {
    for (const name of names) {
      const sel = [`meta[name="${name}" i]`, `meta[property="${name}" i]`, `meta[itemprop="${name}" i]`].join(
        ','
      );
      for (const el of document.querySelectorAll(sel)) {
        const v = (el.getAttribute('content') || '').trim();
        if (v) return v;
      }
    }
    return '';
  };

  const metaAll = (names) => {
    const out = [];
    // The selectors below are case-insensitive, so aliases that differ only in
    // case (dc.creator / DC.creator) would otherwise match the same tag twice
    // and hide the "one tag lists every author" case.
    const seenNames = new Set();
    for (const name of names) {
      const key = name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      const sel = `meta[name="${name}" i],meta[property="${name}" i]`;
      for (const el of document.querySelectorAll(sel)) {
        const v = (el.getAttribute('content') || '').trim();
        if (v) out.push(v);
      }
    }
    return out;
  };

  // --- JSON-LD ----------------------------------------------------------
  const jsonLd = () => {
    const wanted = ['ScholarlyArticle', 'Article', 'Report', 'Thesis', 'Book', 'Chapter', 'Dataset'];
    const nodes = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(el.textContent);
        nodes.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        /* malformed JSON-LD is common; ignore */
      }
    }
    const flat = [];
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      flat.push(n);
      if (Array.isArray(n['@graph'])) flat.push(...n['@graph']);
    }
    return (
      flat.find((n) => {
        const t = n && n['@type'];
        const types = Array.isArray(t) ? t : [t];
        return types.some((x) => wanted.includes(x));
      }) || null
    );
  };

  const ld = jsonLd();
  const ldPerson = (value) => {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list
      .map((a) =>
        typeof a === 'string' ? a : a && (a.name || [a.givenName, a.familyName].filter(Boolean).join(' '))
      )
      .filter(Boolean)
      .map((s) => String(s).trim());
  };

  // --- DOI --------------------------------------------------------------
  // A DOI is 10.<registrant>/<suffix>. The suffix is greedy but must not eat
  // trailing punctuation from prose, closing tags, or URL query strings.
  const DOI_RE = /\b(10\.\d{4,9}\/[-._;()/:A-Z0-9<>+\[\]]+)/i;

  const cleanDoi = (raw) => {
    if (!raw) return '';
    let d = String(raw).trim();
    d = d.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '');
    d = d.replace(/^(doi:|info:doi\/|DOI\s+)/i, '');
    const m = d.match(DOI_RE);
    if (!m) return '';
    // Trim punctuation that is almost certainly sentence/markup noise.
    return m[1].replace(/[.,;:'")\]>]+$/, '').trim();
  };

  const doiFromMeta = cleanDoi(
    meta([
      'citation_doi',
      'bepress_citation_doi',
      'dc.identifier.doi',
      'dc.identifier',
      'DC.identifier',
      'dcterms.identifier',
      'prism.doi',
      'eprints.doi',
      'doi'
    ])
  );

  const doiFromLd = cleanDoi(ld && (ld.doi || ld.identifier || (ld.sameAs && String(ld.sameAs))));

  const doiFromUrl = cleanDoi(decodeURIComponent(location.href));

  const doiFromLinks = (() => {
    for (const a of document.querySelectorAll(
      'a[href*="doi.org/10."],a[href^="doi:"],link[href*="doi.org/10."]'
    )) {
      const d = cleanDoi(a.getAttribute('href'));
      if (d) return d;
    }
    return '';
  })();

  const doiFromText = (() => {
    // Only look where a DOI is plausibly printed, to avoid grabbing a DOI
    // from a reference list at the bottom of the page.
    const scopes = [
      '.doi',
      '#doi',
      '[class*="doi" i]',
      '[data-doi]',
      '.citation',
      '.article-meta',
      '.meta',
      'header',
      'main'
    ];
    for (const sel of scopes) {
      for (const el of document.querySelectorAll(sel)) {
        const dataDoi = cleanDoi(el.getAttribute && el.getAttribute('data-doi'));
        if (dataDoi) return dataDoi;
        const text = (el.textContent || '').slice(0, 4000);
        if (!/doi/i.test(text)) continue;
        const d = cleanDoi(text);
        if (d) return d;
      }
    }
    return '';
  })();

  const doi = doiFromMeta || doiFromLd || doiFromUrl || doiFromLinks || doiFromText;

  // --- arXiv / PubMed ---------------------------------------------------
  const arxivId = (() => {
    const fromMeta = meta(['citation_arxiv_id', 'arxiv_id', 'citation_technical_report_number']);
    const norm = (s) => {
      if (!s) return '';
      const m = String(s).match(/(\d{4}\.\d{4,5}(v\d+)?)|([a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?)/i);
      return m ? m[0] : '';
    };
    return (
      norm(fromMeta) ||
      norm(/arxiv\.org\/(abs|pdf|html)\//i.test(location.href) ? location.href : '') ||
      norm(doi.toLowerCase().startsWith('10.48550/arxiv.') ? doi.slice('10.48550/arxiv.'.length) : '')
    );
  })();

  const pmid = (() => {
    const fromMeta = meta(['citation_pmid', 'ncbi_uid']);
    if (/^\d{5,9}$/.test(fromMeta)) return fromMeta;
    const m = location.href.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/i);
    return m ? m[1] : '';
  })();

  // --- Title ------------------------------------------------------------
  const title = (() => {
    const cand =
      meta([
        'citation_title',
        'bepress_citation_title',
        'dc.title',
        'DC.title',
        'eprints.title',
        'prism.title'
      ]) ||
      (ld && typeof ld.name === 'string' && ld.name) ||
      (ld && typeof ld.headline === 'string' && ld.headline) ||
      meta(['og:title', 'twitter:title']) ||
      (document.querySelector('h1') && document.querySelector('h1').textContent) ||
      document.title;
    return String(cand || '')
      .replace(/\s+/g, ' ')
      .replace(
        /\s*[|\-–—]\s*(arXiv|PubMed|ScienceDirect|SpringerLink|IEEE Xplore|ACM Digital Library|Nature|bioRxiv|medRxiv|SSRN)\b.*$/i,
        ''
      )
      .trim();
  })();

  // --- Authors ----------------------------------------------------------
  const authors = (() => {
    let list = metaAll([
      'citation_author',
      'bepress_citation_author',
      'dc.creator',
      'DC.creator',
      'eprints.creators_name',
      'author'
    ]);
    if (list.length === 1 && /;|\band\b|,\s*[A-Z][a-z]+\s+[A-Z]/.test(list[0])) {
      // A single tag holding every author, e.g. "Doe, J.; Roe, R."
      list = list[0].split(/\s*;\s*|\s+and\s+/i).filter(Boolean);
    }
    if (!list.length && ld) list = ldPerson(ld.author || ld.creator);
    const seen = new Set();
    return list
      .map((a) => String(a).replace(/\s+/g, ' ').trim())
      .filter((a) => a && a.length < 120)
      .filter((a) => {
        const k = a.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 50);
  })();

  // --- Venue / year / abstract -----------------------------------------
  const journal = (
    meta([
      'citation_journal_title',
      'citation_conference_title',
      'citation_inbook_title',
      'bepress_citation_journal_title',
      'prism.publicationName',
      'dc.source',
      'og:site_name'
    ]) ||
    (ld && ld.isPartOf && (ld.isPartOf.name || (ld.isPartOf.isPartOf && ld.isPartOf.isPartOf.name))) ||
    (ld && ld.publication && ld.publication.name) ||
    ''
  )
    .toString()
    .trim();

  const year = (() => {
    const raw =
      meta([
        'citation_publication_date',
        'citation_date',
        'citation_online_date',
        'bepress_citation_date',
        'dc.date',
        'DC.date',
        'prism.publicationDate',
        'article:published_time'
      ]) ||
      (ld && (ld.datePublished || ld.dateCreated)) ||
      '';
    const m = String(raw).match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/);
    return m ? Number(m[1]) : null;
  })();

  const abstract = (() => {
    const cand =
      meta(['citation_abstract', 'dc.description', 'DC.description', 'eprints.abstract', 'prism.teaser']) ||
      (ld && typeof ld.abstract === 'string' && ld.abstract) ||
      (ld && typeof ld.description === 'string' && ld.description) ||
      meta(['og:description', 'description', 'twitter:description']) ||
      (() => {
        const el = document.querySelector(
          '.abstract, #abstract, [class*="abstract" i] p, section[aria-label*="abstract" i], blockquote.abstract'
        );
        return el ? el.textContent : '';
      })();
    return String(cand || '')
      .replace(/\s+/g, ' ')
      .replace(/^abstract[:.\s]*/i, '')
      .trim()
      .slice(0, 4000);
  })();

  const pdfUrl = (() => {
    const m = meta(['citation_pdf_url', 'bepress_citation_pdf_url']);
    if (m) return m;
    const link = document.querySelector('link[type="application/pdf"]');
    return link ? link.href : '';
  })();

  const canonical = (() => {
    const link = document.querySelector('link[rel="canonical"]');
    const og = meta(['og:url']);
    const href = (link && link.href) || og || location.href;
    try {
      const u = new URL(href, location.href);
      // Strip common tracking noise but keep meaningful query params.
      for (const p of [
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_term',
        'utm_content',
        'fbclid',
        'gclid'
      ]) {
        u.searchParams.delete(p);
      }
      return u.toString();
    } catch {
      return location.href;
    }
  })();

  return {
    title,
    url: canonical,
    doi,
    arxivId,
    pmid,
    authors,
    journal,
    year,
    abstract,
    pdfUrl,
    publisher: meta(['citation_publisher', 'dc.publisher', 'DC.publisher']),
    volume: meta(['citation_volume', 'prism.volume']),
    issue: meta(['citation_issue', 'prism.number']),
    pages: (() => {
      const first = meta(['citation_firstpage', 'prism.startingPage']);
      const last = meta(['citation_lastpage', 'prism.endingPage']);
      if (first && last) return `${first}--${last}`;
      return first || '';
    })(),
    siteName: meta(['og:site_name']) || location.hostname.replace(/^www\./, '')
  };
}
