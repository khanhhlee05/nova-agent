import { ToggleGroup } from "radix-ui";
import { FOCUS_CATEGORIES, FOCUS_CATEGORY_LABELS, type FocusCategory } from "../model";
import { pluralize } from "../format";

export type FocusCategoriesProps = {
  value: FocusCategory;
  counts: Record<FocusCategory, number>;
  onChange: (category: FocusCategory) => void;
};

/** One category at a time. Overdue reads in its own tone whenever there is anything in it. */
export const FocusCategories = ({ value, counts, onChange }: FocusCategoriesProps) => (
  <ToggleGroup.Root
    type="single"
    className="categories"
    aria-label="Category"
    value={value}
    onValueChange={(next) => {
      if (next) onChange(next as FocusCategory);
    }}
  >
    {FOCUS_CATEGORIES.map((category) => (
      <ToggleGroup.Item key={category} className="category" value={category} data-tone={category === "overdue" && counts.overdue > 0 ? "overdue" : undefined} aria-label={`${FOCUS_CATEGORY_LABELS[category]}, ${pluralize(counts[category], "item")}`}>
        {FOCUS_CATEGORY_LABELS[category]}
        <span className="count mono" aria-hidden="true">
          {counts[category]}
        </span>
      </ToggleGroup.Item>
    ))}
  </ToggleGroup.Root>
);
