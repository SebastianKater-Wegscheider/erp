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

  const allText = clean(document.body?.innerText || "");
  const bidMatch = allText.match(/(\d+)\s+Gebote/i);
  const endMatch = allText.match(/(Heute,?\s*\d{1,2}:\d{2}|Morgen,?\s*\d{1,2}:\d{2}|\d{1,2}\.\d{1,2}\.\d{4}[^\n]{0,20})/i);

  const imageUrls = Array.from(document.querySelectorAll("img[src*='i.ebayimg.com']"))
    .map((img) => clean(img.getAttribute("src")))
    .filter(Boolean);

  const sellerNode =
    document.querySelector(".x-sellercard-atf__info__about-seller a") ||
    document.querySelector(".mbg-nw") ||
    document.querySelector("a[href*='seller']");

  const shippingNode =
    document.querySelector(".ux-labels-values--shipping .ux-textspans") ||
    document.querySelector("#fshippingCost") ||
    document.querySelector(".d-shipping-minview");

  return {
    title:
      clean(document.querySelector("h1 .x-item-title__mainTitle span")?.textContent) ||
      clean(document.querySelector("h1")?.textContent) ||
      null,
    description_full: clean(document.querySelector("#desc_div")?.textContent) || null,
    price_raw:
      clean(document.querySelector(".x-price-primary span")?.textContent) ||
      clean(document.querySelector(".display-price")?.textContent) ||
      null,
    price_cents: parsePriceCents(
      document.querySelector(".x-price-primary span")?.textContent ||
        document.querySelector(".display-price")?.textContent ||
        "",
    ),
    shipping_raw: clean(shippingNode?.textContent) || null,
    shipping_cents: parsePriceCents(shippingNode?.textContent || ""),
    auction_bid_count: bidMatch ? Number(bidMatch[1]) : null,
    auction_end_at_text: endMatch ? clean(endMatch[1]) : null,
    seller_name: clean(sellerNode?.textContent) || null,
    image_urls: Array.from(new Set(imageUrls)),
    image_count: imageUrls.length > 0 ? imageUrls.length : null,
  };
})();
