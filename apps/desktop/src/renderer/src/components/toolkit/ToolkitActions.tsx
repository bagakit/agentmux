import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { semanticIconComponent } from "@agentmux/client-ui/icons";

const MoreIcon = semanticIconComponent("navigation.down");

/** Reuse the original buttons and callbacks in a bounded bar and a readable menu. */
export function ToolkitActions({
  primary,
  children,
}: {
  primary: ReactElement<{ disabled?: boolean }>;
  children?: ReactNode;
}) {
  return (
    <footer className="performance-actions">
      {primary}
      <Menu.Root modal={false}>
        <Menu.Trigger className="toolkit-actions__more">
          More <MoreIcon size={12} />
        </Menu.Trigger>
        {/* Staying in the panel DOM preserves its outside/hover ownership. */}
        <Menu.Content
          className="toolkit-actions-menu"
          data-toolkit-menu
          side="top"
          align="end"
          sideOffset={5}
          collisionPadding={12}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          {Children.toArray([primary, children]).map((button, index) =>
            isValidElement<{ disabled?: boolean }>(button) ? (
              <Menu.Item
                key={button.key ?? index}
                asChild
                disabled={button.props.disabled ?? false}
              >
                {button}
              </Menu.Item>
            ) : null,
          )}
        </Menu.Content>
      </Menu.Root>
    </footer>
  );
}
