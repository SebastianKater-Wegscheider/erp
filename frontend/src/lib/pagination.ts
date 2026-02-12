export const DEFAULT_PAGE_SIZE = 20;

export type PaginatedResult<T> = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  items: T[];
};

export function paginateItems<T>(
  items: T[],
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): PaginatedResult<T> {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const clampedPage = Math.min(Math.max(1, Math.floor(page || 1)), totalPages);
  const startOffset = (clampedPage - 1) * safePageSize;
  const endOffset = startOffset + safePageSize;
  const pagedItems = items.slice(startOffset, endOffset);

  return {
    page: clampedPage,
    pageSize: safePageSize,
    totalItems,
    totalPages,
    startIndex: totalItems ? startOffset + 1 : 0,
    endIndex: totalItems ? Math.min(endOffset, totalItems) : 0,
    items: pagedItems,
  };
}
