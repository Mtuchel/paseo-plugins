import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Linking, Text, View } from "react-native";
import { openExternalUrl } from "./open-link";
import { z } from "zod";

export const plannotatorRowSchema = z.object({
  title: z.string(),
  url: z.string().url().optional(),
  detail: z.string().optional(),
});

// The chat row for a Plannotator hand-off or decision, added by the server bridge.
export function PlannotatorRow({ item, theme, layout }: PluginTimelineItemProps<z.output<typeof plannotatorRowSchema>>) {
  const { title, url, detail } = item.data;
  return <View style={{ flexDirection: "row", gap: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
    <Icon name="ClipboardCheck" size={16} color={theme.colors.accent} />
    <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{title}</Text>
      {url && <Text accessibilityRole="link" onPress={() => void openExternalUrl(url, { platform: layout.platform, linking: Linking })} style={{ color: theme.colors.accent, textDecorationLine: "underline" }}>{url}</Text>}
      {detail && <Text style={{ color: theme.colors.foregroundMuted }}>{detail}</Text>}
    </View>
  </View>;
}
