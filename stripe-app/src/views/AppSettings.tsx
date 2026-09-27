import { Box, Button, Divider, Icon, Inline, SettingsView } from "@stripe/ui-extension-sdk/ui";

/**
 * What an artist sees after installing Amply in Stripe.
 *
 * This app does nothing inside Stripe. It exists so Stripe can make a key
 * with exactly the permissions Amply needs, instead of the artist choosing
 * them one by one. The key goes to the artist's own streaming service and
 * nowhere else — Amply never receives it.
 */
const AppSettings = () => (
  <SettingsView>
    <Box css={{ padding: "large", borderRadius: "medium", width: "fit" }}>
      <Box css={{ font: "heading", marginBottom: "small" }}>Connect Stripe to your Amply streaming service</Box>
      <Box css={{ stack: "y", gap: "small" }}>
        <Box>1. Click <Inline css={{ font: "bodyEmphasized" }}>View API keys</Inline> on this page.</Box>
        <Box>2. Copy the secret key — it starts rk_. Not the publishable key (pk_), which Amply can't use.</Box>
        <Box>3. In your Amply editor, open Settings → Subscriptions, paste the key, and choose Connect Stripe.</Box>
      </Box>
      <Box css={{ marginTop: "medium", font: "caption", color: "secondary" }}>
        The key can only set up your subscription plans and check who has subscribed. It can't
        move money, see card numbers or pay anything out. It is kept on your own streaming service,
        and Amply never receives it.
      </Box>
      <Box css={{ stack: "x", gap: "small", marginTop: "medium" }}>
        <Button type="primary" target="_blank" href="https://amply.stream/stripe">
          Step-by-step guide
          <Icon name="external" />
        </Button>
        <Button target="_blank" href="https://amply.stream/why#subscriptions">
          How subscriptions work
          <Icon name="external" />
        </Button>
      </Box>
    </Box>
    <Box css={{ marginTop: "large" }}>
      <Divider />
      <Box css={{ font: "caption", color: "secondary", marginTop: "medium" }}>
        Trying it first? Install Amply for Artists in test mode and use that key: nothing real is charged.
        When you're ready, install it in live mode and switch to the live key in your editor.
      </Box>
    </Box>
  </SettingsView>
);

export default AppSettings;
