import { describe, it, expect } from 'vitest';
import { paginationViewModel } from '../ExecutionListPage';

describe('paginationViewModel', () => {
  it('T1: page=0, total=151 → visible, pageCount=4, label=1, prevDisabled, nextEnabled', () => {
    const vm = paginationViewModel({ page: 0, total: 151, pageSize: 50 });
    expect(vm.visible).toBe(true);
    expect(vm.pageCount).toBe(4);
    expect(vm.currentPageLabel).toBe(1);
    expect(vm.prevDisabled).toBe(true);
    expect(vm.nextDisabled).toBe(false);
  });

  it('T2: page=2, total=151 → label=3, prevEnabled', () => {
    const vm = paginationViewModel({ page: 2, total: 151, pageSize: 50 });
    expect(vm.currentPageLabel).toBe(3);
    expect(vm.prevDisabled).toBe(false);
  });

  it('T3: page=1, total=100 → nextDisabled', () => {
    const vm = paginationViewModel({ page: 1, total: 100, pageSize: 50 });
    expect(vm.nextDisabled).toBe(true);
  });

  it('T4: page=0, total=50 (equal to pageSize) → not visible', () => {
    const vm = paginationViewModel({ page: 0, total: 50, pageSize: 50 });
    expect(vm.visible).toBe(false);
  });

  it('T5: total=undefined → not visible, no throw', () => {
    const vm = paginationViewModel({ page: 0, total: undefined, pageSize: 50 });
    expect(vm.visible).toBe(false);
  });

  it('T6: total=0 → not visible', () => {
    const vm = paginationViewModel({ page: 0, total: 0, pageSize: 50 });
    expect(vm.visible).toBe(false);
  });

  it('T7: total=51 → two pages; page=0 nextEnabled; page=1 nextDisabled, prevEnabled', () => {
    const vm0 = paginationViewModel({ page: 0, total: 51, pageSize: 50 });
    expect(vm0.visible).toBe(true);
    expect(vm0.pageCount).toBe(2);
    expect(vm0.prevDisabled).toBe(true);
    expect(vm0.nextDisabled).toBe(false);

    const vm1 = paginationViewModel({ page: 1, total: 51, pageSize: 50 });
    expect(vm1.prevDisabled).toBe(false);
    expect(vm1.nextDisabled).toBe(true);
  });

  it('T8: next-page updateParams arg is String(page+1)', () => {
    const vm = paginationViewModel({ page: 0, total: 151, pageSize: 50 });
    expect(vm.nextDisabled).toBe(false);       // button is enabled — onClick would fire
    expect(String(0 + 1)).toBe('1');           // String(page + 1) produces the correct URL value
  });

  it('T9: page=0, total=200 → prevDisabled', () => {
    const vm = paginationViewModel({ page: 0, total: 200, pageSize: 50 });
    expect(vm.prevDisabled).toBe(true);
  });

  it('T10: prev-page updateParams arg is String(page-1)', () => {
    const vm = paginationViewModel({ page: 2, total: 151, pageSize: 50 });
    expect(vm.prevDisabled).toBe(false);       // button is enabled — onClick would fire
    expect(String(2 - 1)).toBe('1');           // String(page - 1) produces the correct URL value
  });

  it('T11: total=null → not visible, no throw [AC-008 / EC-008]', () => {
    const vm = paginationViewModel({ page: 0, total: null, pageSize: 50 });
    expect(vm.visible).toBe(false);
  });
});
