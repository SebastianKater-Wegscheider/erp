(() => {
  const clean = (value) => (value || "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();

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

  return Array.from(document.querySelectorAll("li.s-item"))
    .map((item) => {
      const link = item.querySelector("a.s-item__link");
      const titleNode = item.querySelector(".s-item__title");
      const priceNode = item.querySelector(".s-item__price");
      const shippingNode = item.querySelector(".s-item__shipping, .s-item__logisticsCost");
      const bidNode = item.querySelector(".s-item__bids, .s-item__bidCount");
      const timeNode = item.querySelector(".s-item__time-left, .s-item__time-end");
      const image = item.querySelector("img");

      const title = clean(titleNode?.textContent);
      const url = absoluteUrl(clean(link?.getAttribute("href")));
      const externalId = extractExternalId(url);

      return {
        external_id: externalId,
        title,
        url,
        price_raw: clean(priceNode?.textContent) || null,
        price_cents: parsePriceCents(priceNode?.textContent),
        shipping_raw: clean(shippingNode?.textContent) || null,
        shipping_cents: parsePriceCents(shippingNode?.textContent),
        bids_raw: clean(bidNode?.textContent) || null,
        auction_bid_count: clean(bidNode?.textContent) || null,
        time_left_raw: clean(timeNode?.textContent) || null,
        auction_end_at_text: clean(timeNode?.textContent) || null,
        image_urls: clean(image?.getAttribute("src")) ? [clean(image.getAttribute("src"))] : [],
        primary_image_url: clean(image?.getAttribute("src")) || null,
      };
    })
    .filter((entry) => entry.external_id && entry.title && entry.url && !/^Shop auf eBay/i.test(entry.title));
})();
