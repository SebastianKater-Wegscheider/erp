(() => {
  // Reference extraction shape used by backend integration.
  return Array.from(document.querySelectorAll('.aditem')).map((item) => {
    const anchor = item.querySelector('a[href]');
    const titleNode = item.querySelector('.aditem-main--top h2');
    const priceNode = item.querySelector('.aditem-main--top--price, .aditem-main--middle--price-shipping--price');
    const img = item.querySelector('img');

    return {
      external_id: item.getAttribute('data-adid') || null,
      title: titleNode ? titleNode.textContent?.trim() : null,
      price_raw: priceNode ? priceNode.textContent?.trim() : null,
      url: anchor ? anchor.getAttribute('href') : null,
      primary_image_url: img ? img.getAttribute('src') : null,
    };
  });
})();
