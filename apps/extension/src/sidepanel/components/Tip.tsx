import { Tooltip } from "radix-ui";
import type { ReactNode } from "react";

/** Tooltip for icon-only controls. The trigger must already carry an aria-label. */
export const Tip = ({ label, children }: { label: string; children: ReactNode }) => (
  <Tooltip.Root delayDuration={300}>
    <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content className="tooltip" sideOffset={6} collisionPadding={8}>
        {label}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
);
