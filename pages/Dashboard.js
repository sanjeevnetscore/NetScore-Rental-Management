import { Page, Card, Layout, Badge } from "@shopify/polaris";
import LicenseBanner from "../components/LicenseBanner";
import FeatureToggle from "../components/FeatureToggle";

export default function Dashboard({ license }) {
  return (
    <Page title="NS Rental Configuration">
      <LicenseBanner remainingDays={license.remainingDays} />

      <Layout>
        <Layout.Section>
          <Card sectioned>
            <p><b>License:</b> {license.licenseKey}</p>
            <Badge status="success">
              Expires in {license.remainingDays} days
            </Badge>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <FeatureToggle title="Simple Product" />
          <FeatureToggle title="Variable Product" />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
