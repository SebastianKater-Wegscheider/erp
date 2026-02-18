(() => {
  const clean = (value) => (value || "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();
  const cleanTitle = (value) =>
    clean(value)
      .replace(/\s*Wird in neuem Fenster oder Tab geöffnet$/i, "")
      .replace(/\s*Opens in a new window or tab$/i, "");
  const normalizeImageUrl = (value) => {
    const url = clean(value);
    if (!url || url.startsWith("data:")) return null;
    if (/\/(?:s_1x2|empty)\.gif/i.test(url)) return null;
    if (url.startsWith("//")) return `https:${url}`;
    return url;
  };
  const firstSrcsetUrl = (rawSrcset) => {
    const srcset = clean(rawSrcset);
    if (!srcset) return null;
    const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
    return normalizeImageUrl(first || "");
  };

  const parsePriceCents = (raw) => {
    const text = clean(raw).toLowerCase().replace("eur", "").replace("€", "");
    if (!text) return null;
    const match = text.match(/(\d{1,7})(?:[.,](\d{1,2}))?/);
    if (!match) return null;
    const euros = Number(match[1] || "0");
    const cents = Number((match[2] || "0").padEnd(2, "0").slice(0, 2));
    if (!Number.isFinite(euros) || !Number.isFinite(cents)) return null;
    return euros * 100 + cents;
  };

  const absoluteUrl = (href) => {
    if (!href) return null;
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    if (href.startsWith("//")) return `https:${href}`;
    if (href.startsWith("/")) return `https://www.ebay.de${href}`;
    return `https://www.ebay.de/${href}`;
  };

  const extractExternalId = (url) => {
    if (!url) return null;
    const direct = url.match(/\/itm\/(?:[^/?]+\/)?(\d{8,20})/);
    if (direct) return direct[1];
    const query = url.match(/[?&]item=(\d{8,20})/);
    if (query) return query[1];
    return null;
  };

  const findTextByRegex = (container, pattern) => {
    const nodes = Array.from(container.querySelectorAll("span, div"));
    for (const node of nodes) {
      const txt = clean(node.textContent);
      if (pattern.test(txt)) return txt;
    }
    return null;
  };

  return Array.from(document.querySelectorAll("li.s-card, li.s-item"))
    .map((item) => {
      const link = item.querySelector("a.s-item__link, a.s-card__link, a[href*='/itm/']");
      const titleNode = item.querySelector(".s-item__title, .s-card__title, h3");
      const priceNode = item.querySelector(".s-item__price, .s-card__price");
      const shippingNode = item.querySelector(".s-item__shipping, .s-item__logisticsCost, .s-card__shipping");
      const bidNode = item.querySelector(".s-item__bids, .s-item__bidCount, .s-card__bidCount");
      const timeNode = item.querySelector(".s-item__time-left, .s-item__time-end, .s-card__time-left, .s-card__time-end");
      const image = item.querySelector("img");

      const title = cleanTitle(titleNode?.textContent);
      const url = absoluteUrl(clean(link?.getAttribute("href")));
      const externalId = extractExternalId(url);
      const bidsText = clean(bidNode?.textContent) || findTextByRegex(item, /\b\d+\s+Gebote\b/i) || null;
      const timeText =
        clean(timeNode?.textContent) || findTextByRegex(item, /\b(Noch|Heute|Morgen)\b/i) || null;
      const imageSrc =
        normalizeImageUrl(image?.getAttribute("data-src")) ||
        normalizeImageUrl(image?.getAttribute("data-lazy-src")) ||
        normalizeImageUrl(image?.getAttribute("data-zoom-src")) ||
        normalizeImageUrl(image?.getAttribute("data-img-src")) ||
        normalizeImageUrl(image?.getAttribute("src")) ||
        firstSrcsetUrl(image?.getAttribute("data-srcset")) ||
        firstSrcsetUrl(image?.getAttribute("srcset"));

      return {
        external_id: externalId,
        title,
        url,
        price_raw: clean(priceNode?.textContent) || null,
        price_cents: parsePriceCents(priceNode?.textContent),
        shipping_raw: clean(shippingNode?.textContent) || null,
        shipping_cents: parsePriceCents(shippingNode?.textContent),
        bids_raw: bidsText,
        auction_bid_count: bidsText,
        time_left_raw: timeText,
        auction_end_at_text: timeText,
        image_urls: imageSrc ? [imageSrc] : [],
        primary_image_url: imageSrc || null,
      };
    })
    .filter((entry) => entry.external_id && entry.title && entry.url && !/^Shop (auf|on) eBay/i.test(entry.title));
})();
