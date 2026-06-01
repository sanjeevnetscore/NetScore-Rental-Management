import {
  Page,
  Card,
  Button,
  TextField,
  Tabs,
  FormLayout,
  Text
} from "@shopify/polaris";
import { useState } from "react";

export default function Login({ onLoginSuccess }) {
  const [selected, setSelected] = useState(0);

  const [form, setForm] = useState({
    authCode: "",
    licenseKey: "",
    productCode: "",
    accountId: "",
    licenceUrl: "https://license.netscoretech.com/api/Account/GetLicenseDetails",
    username: "",
    password: "",
  });

  const tabs = [
    { id: "netsuite", content: "NetSuite Customer" },
    { id: "rental", content: "Rental Customer" },
  ];

  const submit = async () => {
    const endpoint =
      selected === 0 ? "/api/login/netsuite" : "/api/login/rental";

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });

    const data = await res.json();

    if (data.success) {
      onLoginSuccess({ ...data });
    } else {
      alert(data.error || "Login failed");
    }
  };

  return (
    <Page title="Login">
      <Card sectioned>
        <Tabs tabs={tabs} selected={selected} onSelect={setSelected} />

        {/* ✅ NetSuite Login */}
        {selected === 0 && (
          <>
            <Text variant="headingMd">NetSuite Customer Login</Text>

            <FormLayout>
              <TextField
                label="Auth Code"
                value={form.authCode}
                onChange={(v) => setForm({ ...form, authCode: v })}
              />

              <TextField
                label="License Key"
                value={form.licenseKey}
                onChange={(v) => setForm({ ...form, licenseKey: v })}
              />

              <TextField
                label="Product Code"
                value={form.productCode}
                onChange={(v) => setForm({ ...form, productCode: v })}
              />

              <TextField
                label="Account ID"
                value={form.accountId}
                onChange={(v) => setForm({ ...form, accountId: v })}
              />

              <TextField
                label="Licence URL"
                value={form.licenceUrl}
                onChange={(v) => setForm({ ...form, licenceUrl: v })}
              />
            </FormLayout>
          </>
        )}

        {/* ✅ Rental Login */}
        {selected === 1 && (
          <>
            <Text variant="headingMd">Rental Customer Login</Text>

            <FormLayout>
              <TextField
                label="License Key"
                value={form.licenseKey}
                onChange={(v) => setForm({ ...form, licenseKey: v })}
              />

              <TextField
                label="Username"
                value={form.username}
                onChange={(v) => setForm({ ...form, username: v })}
              />

              <TextField
                label="Password"
                type="password"
                value={form.password}
                onChange={(v) => setForm({ ...form, password: v })}
              />
            </FormLayout>
          </>
        )}

        <div style={{ marginTop: 20 }}>
          <Button primary onClick={submit}>
            Confirm & Login
          </Button>
        </div>
      </Card>
    </Page>
  );
}
