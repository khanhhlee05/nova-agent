import { ArrowDownUp, Check } from "lucide-react";
import { Select } from "radix-ui";
import { SORT_KEYS, SORT_LABELS, type SortKey } from "../model";

export type SortSelectProps = { value: SortKey; onChange: (value: SortKey) => void };

export const SortSelect = ({ value, onChange }: SortSelectProps) => (
  <Select.Root value={value} onValueChange={(next) => onChange(next as SortKey)}>
    <Select.Trigger className="select-trigger" aria-label="Sort by">
      <ArrowDownUp size={13} aria-hidden="true" />
      <Select.Value />
    </Select.Trigger>
    <Select.Portal>
      <Select.Content className="select-content" position="popper" sideOffset={6} collisionPadding={8} align="end">
        <Select.Viewport>
          {SORT_KEYS.map((key) => (
            <Select.Item className="select-item" value={key} key={key}>
              <Select.ItemText>{SORT_LABELS[key]}</Select.ItemText>
              <Select.ItemIndicator>
                <Check size={14} aria-hidden="true" />
              </Select.ItemIndicator>
            </Select.Item>
          ))}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
);
