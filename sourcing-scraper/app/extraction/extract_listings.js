(() => {
  const clean = (value) => (value || "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();

  const parsePriceCents = (raw) => {
    const text = clean(raw).toLowerCase();
    if (!text) {
      return null;
    }
    if (text.includes("zu verschenken")) {
      return 0;
    }
    const match = text.match(/(\d{1,5})(?:[.,](\d{1,2}))?/);
    if (!match) {
      return null;
    }
    const euros = Number(match[1] || "0");
    const cents = Number((match[2] || "0").padEnd(2, "0").slice(0, 2));
    if (!Number.isFinite(euros) || !Number.isFinite(cents)) {
      return null;
    }
    return euros * 100 + cents;
  };

  const parseBool = (value) => {
    if (value === true) return true;
    if (value === false) return false;
    if (value === null || value === undefined) return null;
    const normalized = clean(String(value)).toLowerCase();
    if (["true", "1", "yes", "ja"].includes(normalized)) return true;
    if (["false", "0", "no", "nein"].includes(normalized)) return false;
    return null;
  };

  const parseImageCount = (raw) => {
    const text = clean(raw);
    if (!text) return null;
    const match = text.match(/\d+/);
    return match ? Number(match[0]) : null;
  };

  const absoluteUrl = (href) => {
    if (!href) return null;
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    if (href.startsWith("/")) return `https://www.kleinanzeigen.de${href}`;
    return `https://www.kleinanzeigen.de/${href}`;
  };

  return Array.from(document.querySelectorAll("article.aditem[data-adid]"))
    .map((item) => {
      const anchor = item.querySelector("a[href]");
      const titleNode = item.querySelector(".aditem-main--middle h2 a, .aditem-main--middle h2");
      const descNode = item.querySelector(".aditem-main--middle--description");
      const priceNode = item.querySelector(".aditem-main--middle--price-shipping--price");
      const oldPriceNode = item.querySelector(".aditem-main--middle--price-shipping--old-price");
      const img = item.querySelector("img");
      const locationNode = item.querySelector(".aditem-main--top--left");
      const postedAtNode = item.querySelector(".aditem-main--top--right");
      const imageCountNode = item.querySelector(".galleryimage--counter");
      const tags = Array.from(item.querySelectorAll(".aditem-main--bottom .simpletag, .aditem-main--bottom [class*='simpletag']"))
        .map((n) => clean(n.textContent))
        .filter(Boolean);

      const locationText = clean(locationNode?.textContent);
      const zipMatch = locationText.match(/\b\d{5}\b/);
      const locationZip = zipMatch ? zipMatch[0] : null;
      const locationCity = locationZip ? clean(locationText.replace(locationZip, "")) : locationText || null;

      const priceRaw = clean(priceNode?.textContent);
      const oldPriceRaw = clean(oldPriceNode?.textContent);
      const priceNegotiable = /\bvb\b/i.test(priceRaw);
      const shippingPossible = tags.some((t) => /versand möglich/i.test(t));
      const directBuy = tags.some((t) => /direkt kaufen/i.test(t));

      const imgSrcset = clean(img?.getAttribute("srcset"));
      const firstSrcsetUrl = imgSrcset ? imgSrcset.split(",")[0]?.trim().split(" ")[0] : null;
      const primaryImageUrl = clean(img?.getAttribute("src")) || firstSrcsetUrl || null;
      const adHref = item.getAttribute("data-href") || anchor?.getAttribute("href");
      const title = clean(titleNode?.textContent);

      return {
        external_id: clean(item.getAttribute("data-adid")),
        title: title || null,
        description: clean(descNode?.textContent) || null,
        price_cents: parsePriceCents(priceRaw),
        url: absoluteUrl(clean(adHref)),
        image_urls: primaryImageUrl ? [primaryImageUrl] : [],
        primary_image_url: primaryImageUrl,
        location_zip: locationZip,
        location_city: locationCity,
        seller_type: "private",
        posted_at_text: clean(postedAtNode?.textContent) || null,
        shipping_possible: parseBool(shippingPossible),
        direct_buy: parseBool(directBuy),
        price_negotiable: parseBool(priceNegotiable),
        old_price_cents: parsePriceCents(oldPriceRaw),
        image_count: parseImageCount(imageCountNode?.textContent),
      };
    })
    .filter((entry) => entry.external_id && entry.title && entry.url);
})();
