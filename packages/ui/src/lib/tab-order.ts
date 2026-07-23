export function insertSiblingTab<T>(
  tabs: T[],
  activeKey: string | null,
  getKey: (tab: T) => string,
  tab: T,
): T[] {
  const activeIndex = activeKey ? tabs.findIndex(item => getKey(item) === activeKey) : -1;
  if (activeIndex < 0) return [...tabs, tab];
  const next = [...tabs];
  next.splice(activeIndex + 1, 0, tab);
  return next;
}
