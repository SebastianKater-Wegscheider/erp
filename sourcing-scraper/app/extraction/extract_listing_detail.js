(() => {
  const clean = (value) => (value || "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim();

  const parsePriceCents = (raw) => {
    const text = clean(raw).toLowerCase();
    if (!text) return null;
    if (text.includes("zu verschenken")) return 0;
    const match = text.match(/(\d{1,5})(?:[.,](\d{1,2}))?/);
    if (!match) return null;
    const euros = Number(match[1] || "0");
    const cents = Number((match[2] || "0").padEnd(2, "0").slice(0, 2));
    if (!Number.isFinite(euros) || !Number.isFinite(cents)) return null;
    return euros * 100 + cents;
  };

  const absoluteUrl = (href) => {
    if (!href) return null;
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    if (href.startsWith("/")) return `https://www.kleinanzeigen.de${href}`;
    return `https://www.kleinanzeigen.de/${href}`;
  };

  const contactText = clean(document.querySelector("#viewad-contact")?.innerText);
  const memberSinceMatch = contactText.match(/Aktiv seit\s*(\d{2}\.\d{2}\.\d{4})/i);
  const sellerType = /gewerblich|gewerblicher nutzer/i.test(contactText)
    ? "commercial"
    : /privater nutzer/i.test(contactText)
      ? "private"
      : null;

  const imageUrls = Array.from(
    document.querySelectorAll(
      "#vip-gallery img, .galleryimage-element img, .galleryimage img, #viewad-image img, img[itemprop='contentUrl']",
    ),
  )
    .map((img) => absoluteUrl(clean(img.getAttribute("src") || img.getAttribute("data-src"))))
    .filter(Boolean);

  const postedAtText =
    clean(document.querySelector("#viewad-extra-info span")?.textContent) ||
    clean(document.querySelector(".boxedarticle--details--full span")?.textContent) ||
    null;

  const priceRaw =
    clean(document.querySelector("#viewad-price")?.textContent) ||
    clean(document.querySelector(".boxedarticle--price")?.textContent) ||
    clean(document.querySelector(".boxedarticle--price--amount")?.textContent) ||
    null;

  const oldPriceRaw =
    clean(document.querySelector(".boxedarticle--price-shipping--old-price")?.textContent) ||
    clean(document.querySelector(".aditem-main--middle--price-shipping--old-price")?.textContent) ||
    null;

  const viewCountRaw = clean(document.querySelector("#viewad-cntr-num")?.textContent);
  const viewCount = /^\d+$/.test(viewCountRaw) ? Number(viewCountRaw) : null;

  return {
    title: clean(document.querySelector("h1")?.textContent) || null,
    description_full: clean(document.querySelector("#viewad-description-text")?.textContent) || null,
    posted_at_text: postedAtText,
    price_cents: parsePriceCents(priceRaw),
    price_negotiable: /\bvb\b/i.test(priceRaw || ""),
    old_price_cents: parsePriceCents(oldPriceRaw),
    image_urls: Array.from(new Set(imageUrls)),
    image_count: imageUrls.length > 0 ? imageUrls.length : null,
    seller_name:
      clean(
        document.querySelector("#viewad-contact .boxedarticle--details--seller")?.textContent ||
          document.querySelector(".userprofile-box .userprofile-name")?.textContent,
      ) || null,
    seller_member_since_text: memberSinceMatch ? memberSinceMatch[1] : null,
    seller_type: sellerType,
    shipping_possible: /versand möglich/i.test(contactText),
    direct_buy: /direkt kaufen/i.test(contactText),
    view_count: viewCount,
  };
})();
