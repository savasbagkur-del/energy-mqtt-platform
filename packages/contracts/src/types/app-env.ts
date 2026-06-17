export interface AppEnv {
  NODE_ENV: string;
  API_PORT: number;
  POSTGRES_HOST: string;
  POSTGRES_PORT: number;
  POSTGRES_DB: string;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  MQTT_HOST: string;
  MQTT_PORT: number;
  MQTT_USERNAME: string;
  MQTT_PASSWORD: string;
  MQTT_CLIENT_ID: string;
}
