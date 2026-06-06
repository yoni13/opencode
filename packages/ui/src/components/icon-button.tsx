import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, splitProps } from "solid-js"
import { Icon, IconProps } from "./icon"
import { Spinner } from "./spinner"

export interface IconButtonProps extends ComponentProps<typeof Kobalte> {
  icon: IconProps["name"]
  loading?: boolean
  size?: "small" | "normal" | "large"
  iconSize?: IconProps["size"]
  variant?: "primary" | "secondary" | "ghost"
}

export function IconButton(props: ComponentProps<"button"> & IconButtonProps) {
  const [split, rest] = splitProps(props, ["variant", "size", "iconSize", "loading", "class", "classList"])
  return (
    <Kobalte
      {...rest}
      data-component="icon-button"
      data-icon={props.icon}
      data-loading={split.loading ? "" : undefined}
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.loading ? (
        <Spinner class="icon-button-spinner" />
      ) : (
        <Icon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />
      )}
    </Kobalte>
  )
}
