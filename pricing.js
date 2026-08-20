/* One source of truth for what a piece actually costs.
 *
 * Precedence: a discount set on the product always beats the store-wide one,
 * so a piece you have deliberately marked down is never further reduced by a
 * seasonal offer. Nothing here trusts the browser — /api/orders calls the same
 * function before writing an order.
 */

export const MAX_DISCOUNT = 90;   // a 100% discount is always a mistake

export function priceOf(product, storeDiscountPercent = 0) {
  const list = Math.max(0, Number(product.price) || 0);
  const type = product.discount_type || 'none';
  const value = Math.max(0, Number(product.discount_value) || 0);

  let final = list;
  let source = 'none';

  if (type === 'percent' && value > 0) {
    final = Math.round(list * (1 - Math.min(MAX_DISCOUNT, value) / 100));
    source = 'product';
  } else if (type === 'amount' && value > 0) {
    // Never let a flat discount exceed the cap, even if a bad value is stored.
    const floor = Math.round(list * (1 - MAX_DISCOUNT / 100));
    final = Math.max(floor, list - value);
    source = 'product';
  } else if (storeDiscountPercent > 0) {
    final = Math.round(list * (1 - Math.min(MAX_DISCOUNT, storeDiscountPercent) / 100));
    source = 'store';
  }

  if (final > list) final = list;
  if (final < 0) final = 0;

  const percent = list > 0 && final < list
    ? Math.round((1 - final / list) * 100)
    : 0;

  return {
    list_price: list,          // struck through on the storefront
    final_price: final,        // what the customer pays
    discount_percent: percent, // shown as the badge
    discount_source: source    // 'product' | 'store' | 'none'
  };
}

/* Attaches pricing fields to a product row, in place. */
export function withPricing(product, storeDiscountPercent = 0) {
  if (!product) return product;
  return Object.assign(product, priceOf(product, storeDiscountPercent));
}
