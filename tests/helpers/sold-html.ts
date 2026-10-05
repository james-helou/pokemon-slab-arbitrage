/** Builds an eBay sold-search page in the legacy `li.s-item` markup the v0 parser reads. */
export function soldHtml(sales: { title?: string; price: number; sold: string }[]): string {
  const items = sales.map((s) => `
  <li class="s-item">
    <div class="s-item__caption"><span class="s-item__caption--signal POSITIVE"><span>Sold  ${s.sold}</span></span></div>
    <div class="s-item__title"><span role="heading">${s.title ?? 'PSA 10 Charizard ex 199/165 151 Special Illustration Rare'}</span></div>
    <span class="s-item__price"><span class="POSITIVE">$${s.price.toFixed(2)}</span></span>
  </li>`);
  return `<!DOCTYPE html><html><body><ul class="srp-results">${items.join('')}</ul></body></html>`;
}
