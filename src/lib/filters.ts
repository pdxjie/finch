export interface FilterOperator {
  value: string;
  label: string;
}

/** Operators shown in the inline table filter builder. */
export const FILTER_OPERATORS: FilterOperator[] = [
  { value: '=', label: '等于' },
  { value: '!=', label: '不等于' },
  { value: '>', label: '大于' },
  { value: '>=', label: '大于等于' },
  { value: '<', label: '小于' },
  { value: '<=', label: '小于等于' },
  { value: 'CONTAINS', label: '包含' },
  { value: 'NOT CONTAINS', label: '不包含' },
  { value: 'STARTS WITH', label: '开头是' },
  { value: 'ENDS WITH', label: '结尾是' },
  { value: 'IS NULL', label: '是 NULL' },
  { value: 'IS NOT NULL', label: '不是 NULL' },
  { value: 'IS EMPTY', label: '是空的' },
  { value: 'IS NOT EMPTY', label: '不是空的' },
  { value: 'IN', label: '在列表中' },
  { value: 'NOT IN', label: '不在列表中' },
  { value: 'BETWEEN', label: '介于' },
  { value: 'NOT BETWEEN', label: '不介于' },
];

export function filterOperatorLabel(op: string): string {
  return FILTER_OPERATORS.find((item) => item.value === op)?.label || op;
}

export function filterNeedsValue(op: string): boolean {
  return !['IS NULL', 'IS NOT NULL', 'IS EMPTY', 'IS NOT EMPTY'].includes(op);
}

export function filterNeedsSecondValue(op: string): boolean {
  return op === 'BETWEEN' || op === 'NOT BETWEEN';
}

export function filterIsMultiValue(op: string): boolean {
  return op === 'IN' || op === 'NOT IN';
}
