#!/bin/bash
# deploy-ultimate.sh - Setup 100% automático en Cloudflare

set -e  # Detener en cualquier error

# Configuración
REPO_URL="https://github.com/tu-usuario/phantom-enterprise.git" # Please change this to your actual repo URL
DOMAIN="tu-dominio.com"  # Cambia esto por tu dominio
TUNNEL_NAME="phantom-gateway"

# Paso 1: Instalar dependencias globales
echo "🔧 Instalando dependencias..."
if command -v apt-get &> /dev/null; then
    sudo apt-get update -y
    sudo apt-get install -y jq nodejs npm golang docker.io
elif command -v yum &> /dev/null; then
    sudo yum update -y
    sudo yum install -y jq nodejs npm golang docker
elif command -v brew &> /dev/null; then
    brew install jq node npm go docker
else
    echo "No se pudo determinar el gestor de paquetes. Por favor, instala jq, nodejs, npm, golang y docker.io manualmente."
    exit 1
fi
sudo npm install -g wrangler cloudflared

# Paso 2: Clonar repositorio (o usar los archivos locales si ya está en el repo)
if [ -d ".git" ]; then
    echo "📥 Usando repositorio local..."
    # Asegurarse que estamos en el directorio raíz del repo
    # cd $(git rev-parse --show-toplevel)
else
    echo "📥 Clonando repositorio..."
    git clone $REPO_URL phantom-gateway-deploy
    cd phantom-gateway-deploy
fi


# Paso 3: Configurar Cloudflare Tunnel
echo "🚇 Configurando Cloudflare Tunnel..."
echo "Por favor, autentícate con Cloudflare si se te solicita..."
if ! cloudflared whoami &> /dev/null; then
    cloudflared login
fi

TUNNEL_EXISTS=$(cloudflared tunnel list --output json | jq -r --arg TUNNEL_NAME "$TUNNEL_NAME" '.[] | select(.name == $TUNNEL_NAME) | .id')

if [ -z "$TUNNEL_EXISTS" ]; then
    echo "Creando nuevo túnel: $TUNNEL_NAME"
    TUNNEL_CRED_OUTPUT=$(cloudflared tunnel create $TUNNEL_NAME --output json)
    TUNNEL_ID=$(echo $TUNNEL_CRED_OUTPUT | jq -r '.result.id')
    TUNNEL_CRED_FILE_CONTENT=$(echo $TUNNEL_CRED_OUTPUT | jq -r '.result.credentials_file_content')

    # Guardar las credenciales del túnel en un archivo temporal seguro
    TEMP_TUNNEL_CRED_FILE=$(mktemp)
    echo "$TUNNEL_CRED_FILE_CONTENT" > "$TEMP_TUNNEL_CRED_FILE"
    echo "Credenciales del túnel guardadas temporalmente en $TEMP_TUNNEL_CRED_FILE"
else
    echo "Túnel existente '$TUNNEL_NAME' encontrado con ID: $TUNNEL_EXISTS"
    TUNNEL_ID=$TUNNEL_EXISTS
    # Para túneles existentes, las credenciales podrían no estar disponibles directamente.
    # El usuario podría necesitar configurar el archivo de credenciales manualmente si 'cloudflared tunnel run' falla.
    echo "Asegúrate de tener el archivo de credenciales para el túnel $TUNNEL_NAME si es necesario."
    # Intentaremos encontrar un archivo de credenciales común o pedir al usuario.
    if [ -f "$HOME/.cloudflared/$TUNNEL_ID.json" ]; then
        TEMP_TUNNEL_CRED_FILE="$HOME/.cloudflared/$TUNNEL_ID.json"
        echo "Usando archivo de credenciales existente: $TEMP_TUNNEL_CRED_FILE"
    else
        echo "No se encontró un archivo de credenciales para el túnel existente. El script puede fallar al iniciar el túnel."
        echo "Puedes intentar ejecutar 'cloudflared tunnel token $TUNNEL_ID' y configurar el archivo de credenciales manualmente."
        # Como fallback, creamos un archivo vacío para que el script no falle, aunque el túnel no inicie.
        TEMP_TUNNEL_CRED_FILE=$(mktemp)
        echo "{}" > "$TEMP_TUNNEL_CRED_FILE" # Placeholder
    fi
fi


# Configurar DNS
echo "Configurando DNS para $TUNNEL_NAME.$DOMAIN..."
cloudflared tunnel route dns $TUNNEL_ID $TUNNEL_NAME.$DOMAIN

# Paso 4: Configurar Worker
cd orchestrator/cloudflare
echo "🛠️ Configurando Cloudflare Worker..."

# Autenticar wrangler si no está ya autenticado
if ! wrangler whoami &> /dev/null; then
    echo "Por favor, autentícate con Wrangler (Cloudflare Workers)..."
    wrangler login
fi

# Crear recursos
echo "Creando base de datos D1 'phantom-db'..."
DB_OUTPUT=$(wrangler d1 create phantom-db --output json || echo "{\"id\":\"EXISTING_DB_ID_PLACEHOLDER\"}") # Fallback si ya existe
DB_ID=$(echo $DB_OUTPUT | jq -r '.id')
if [ "$DB_ID" == "EXISTING_DB_ID_PLACEHOLDER" ] || [ -z "$DB_ID" ] || [ "$DB_ID" == "null" ]; then
    echo "No se pudo crear la DB D1 automáticamente o ya existe. Intentando obtener ID de DB existente..."
    DB_ID=$(wrangler d1 list --output json | jq -r '.[] | select(.name == "phantom-db") | .uuid' | head -n 1)
    if [ -z "$DB_ID" ]; then
        echo "Error: No se pudo crear u obtener la DB D1 'phantom-db'. Por favor, créala manualmente y actualiza wrangler.toml."
        exit 1
    fi
    echo "Usando DB D1 existente con ID: $DB_ID"
fi


echo "Creando KV namespace 'PHANTOM_STREAMS'..."
KV_OUTPUT=$(wrangler kv:namespace create PHANTOM_STREAMS --output json || echo "{\"id\":\"EXISTING_KV_ID_PLACEHOLDER\"}") # Fallback
KV_ID=$(echo $KV_OUTPUT | jq -r '.id')
if [ "$KV_ID" == "EXISTING_KV_ID_PLACEHOLDER" ] || [ -z "$KV_ID" ] || [ "$KV_ID" == "null" ]; then
    echo "No se pudo crear el KV namespace automáticamente o ya existe. Intentando obtener ID de KV existente..."
    KV_ID=$(wrangler kv:namespace list --output json | jq -r '.[] | select(.title == "PHANTOM_STREAMS") | .id' | head -n 1)
     if [ -z "$KV_ID" ]; then
        echo "Error: No se pudo crear u obtener el KV Namespace 'PHANTOM_STREAMS'. Por favor, créalo manualmente y actualiza wrangler.toml."
        exit 1
    fi
    echo "Usando KV Namespace existente con ID: $KV_ID"
fi

# Actualizar configuración wrangler.toml
echo "Actualizando wrangler.toml con DB_ID: $DB_ID y KV_ID: $KV_ID"
# Usar awk para una sustitución más robusta que sed en diferentes OS
awk -v db_id="$DB_ID" '{gsub(/database_id = ".*"/, "database_id = \"" db_id "\"")}1' wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml
awk -v kv_id="$KV_ID" '{gsub(/id = ".*"$/, "id = \"" kv_id "\"")}1' wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml


# Configurar secrets
AUTH_SECRET=$(openssl rand -hex 32)
TUNNEL_HOST_VAR="$TUNNEL_NAME.$DOMAIN" # Renombrar para evitar conflicto con la variable global TUNNEL_HOST
echo "Configurando secrets del worker..."
wrangler secret put AUTH_SECRET <<< $AUTH_SECRET
wrangler secret put TUNNEL_HOST <<< $TUNNEL_HOST_VAR
wrangler secret put TUNNEL_PORT <<< "443" # Cloudflare Tunnel por defecto usa HTTPS en el puerto 443 externamente

# Desplegar worker
echo "Desplegando worker..."
wrangler deploy
WORKER_URL=$(wrangler deployments list --output json | jq -r '.[0].url') # Toma la URL del último despliegue
if [ -z "$WORKER_URL" ] || [ "$WORKER_URL" == "null" ]; then
    echo "Error: No se pudo obtener la URL del worker después del despliegue."
    # Como fallback, intenta construirla si el nombre está en wrangler.toml
    WORKER_NAME=$(grep name wrangler.toml | head -1 | awk -F'"' '{print $2}')
    ACCOUNT_SUBDOMAIN=$(wrangler whoami --output json | jq -r '.account_subdomain')
    if [ -n "$WORKER_NAME" ] && [ -n "$ACCOUNT_SUBDOMAIN" ]; then
        WORKER_URL="https://$WORKER_NAME.$ACCOUNT_SUBDOMAIN.workers.dev"
        echo "URL del worker construida como fallback: $WORKER_URL"
    else
        echo "No se pudo construir la URL del worker. Por favor, verifica el despliegue manualmente."
        exit 1
    fi
fi


# Paso 5: Configurar cliente
cd ../../client
echo "📱 Configurando cliente..."
cat > config.json <<EOL
{
  "workerUrl": "$WORKER_URL",
  "secret": "$AUTH_SECRET",
  "socksPort": 1080
}
EOL

echo "Instalando dependencias del cliente..."
npm install

# Paso 6: Iniciar servicios
echo "🚀 Iniciando todos los servicios..."

LOG_DIR="../../logs"
mkdir -p $LOG_DIR

# Iniciar Cloudflare Tunnel en segundo plano
echo "Iniciando Cloudflare Tunnel..."
if [ -f "$TEMP_TUNNEL_CRED_FILE" ] && [ -s "$TEMP_TUNNEL_CRED_FILE" ] && [ "$(cat $TEMP_TUNNEL_CRED_FILE)" != "{}" ]; then
    cloudflared tunnel --credentials-file "$TEMP_TUNNEL_CRED_FILE" run $TUNNEL_ID > "$LOG_DIR/tunnel.log" 2>&1 &
    TUNNEL_PID=$!
    echo "Cloudflare Tunnel iniciado con PID $TUNNEL_PID. Logs en $LOG_DIR/tunnel.log"
else
    echo "Advertencia: No se pudo iniciar Cloudflare Tunnel debido a la falta de credenciales válidas. Por favor, inícialo manualmente."
fi


# Iniciar backend en segundo plano
cd ../backend
echo "Instalando dependencias del backend..."
npm install
echo "Iniciando backend..."
node index.js > "$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo "Backend iniciado con PID $BACKEND_PID. Logs en $LOG_DIR/backend.log"

# Iniciar cliente en segundo plano
cd ../client
echo "Iniciando cliente..."
node index.js > "$LOG_DIR/client.log" 2>&1 &
CLIENT_PID=$!
echo "Cliente iniciado con PID $CLIENT_PID. Logs en $LOG_DIR/client.log"

# Limpiar archivo temporal de credenciales del túnel si se creó uno nuevo
if [[ "$TEMP_TUNNEL_CRED_FILE" == /tmp/* ]]; then
    echo "Limpiando archivo temporal de credenciales del túnel: $TEMP_TUNNEL_CRED_FILE"
    rm -f "$TEMP_TUNNEL_CRED_FILE"
fi

# Paso 7: Verificar instalación
echo "✅ ¡Instalación completada!"
echo "-----------------------------------------------"
echo "🔌 Proxy SOCKS5: 127.0.0.1:1080"
echo "🌐 URL del Worker: $WORKER_URL"
echo "🔗 URL del Túnel (hostname para el worker): $TUNNEL_HOST_VAR"
echo "🔑 Secret (AUTH_SECRET para el worker): $AUTH_SECRET"
echo "-----------------------------------------------"
echo "Para verificar la conexión, espera unos segundos y luego ejecuta:"
echo "curl --socks5-hostname 127.0.0.1:1080 ifconfig.me"
echo "-----------------------------------------------"
echo "Logs disponibles en el directorio: $LOG_DIR"
echo "PIDs: Tunnel ($TUNNEL_PID), Backend ($BACKEND_PID), Client ($CLIENT_PID)"
echo "Para detener los servicios: kill $TUNNEL_PID $BACKEND_PID $CLIENT_PID"


# Intento automático de conexión
echo "🧪 Verificando conexión (espera 15 segundos)..."
sleep 15 # Esperar que los servicios inicien
VERIFY_LOG="$LOG_DIR/verify.log"
if curl --socks5-hostname 127.0.0.1:1080 -m 10 https://ifconfig.me > "$VERIFY_LOG" 2>&1; then
    PUBLIC_IP=$(cat "$VERIFY_LOG")
    echo "🎉 ¡Conexión exitosa! IP pública a través del proxy: $PUBLIC_IP"
else
    echo "❌ Error en la conexión automática. Consulta los logs:"
    echo "  - $LOG_DIR/tunnel.log"
    echo "  - $LOG_DIR/backend.log"
    echo "  - $LOG_DIR/client.log"
    echo "  - $VERIFY_LOG (resultado del intento de curl)"
fi

cd ../.. # Volver al directorio raíz del repo si se clonó
echo "Script finalizado."
