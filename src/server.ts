import 'dotenv/config';

const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const;
const missingEnvVars = requiredEnvVars.filter((name) => {
  const value = process.env[name];
  return !value || value.trim().length === 0;
});

if (missingEnvVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
}

const { app } = await import('./app.js');

const portValue = Number(process.env.PORT || 3000);
const port = Number.isFinite(portValue) && portValue > 0 ? portValue : 3000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port}`);
});
