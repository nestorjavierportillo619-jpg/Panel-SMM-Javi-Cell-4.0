<?php
// Configuración de la Base de Datos
$host = 'localhost';
$db   = 'tu_base_de_datos';
$user = 'tu_usuario';
$pass = 'tu_contraseña';

try {
    $pdo = new PDO("mysql:host=$host;dbname=$db;charset=utf8mb4", $user, $pass, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION
    ]);
} catch (PDOException $e) {
    die(json_encode(['status' => 'error', 'message' => 'Error de conexión a la Base de Datos']));
}

// Datos de tu proveedor
$apiUrl = "https://api.proveedor-smm.com/v2"; 
$apiKey = "TU_API_KEY_AQUI";                 

// CONFIGURACIÓN DE TU GANANCIA (Markup)
$porcentajeGanancia = 1.30; 

$data = [
    'key'    => $apiKey,
    'action' => 'services'
];

// Petición cURL a la API del proveedor
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $apiUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($data));
curl_setopt($ch, CURLOPT_TIMEOUT, 25);
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// PASO 1: Validar si el proveedor está OFFLINE o dio error
if ($httpCode !== 200 || !$response) {
    file_put_contents('sync_error_log.txt', date('Y-m-d H:i:s') . " - Alerta: Proveedor offline o sin respuesta (HTTP: $httpCode)\n", FILE_APPEND);
    
    echo json_encode([
        'status' => 'warning',
        'message' => 'El proveedor no respondió o estás offline. Se mantuvo el catálogo local intacto.'
    ]);
    exit;
}

$services = json_decode($response, true);

// PASO 2: Validar formato de respuesta
if (!is_array($services) || empty($services)) {
    echo json_encode([
        'status' => 'warning',
        'message' => 'La respuesta del proveedor está vacía. No se hicieron cambios.'
    ]);
    exit;
}

// PASO 3: Iniciar Transacción y aplicar actualización segura
try {
    $pdo->beginTransaction();

    // Marcar servicios locales como inactivos temporalmente (Soft Delete)
    $pdo->query("UPDATE servicios SET is_available = 0");

    // Preparar inserción incluyendo input_type y price_type ('per_1k' por defecto al insertar)
    // Se utiliza IFNULL para conservar configuraciones personalizadas hechas en el Admin.
    $stmt = $pdo->prepare("
        INSERT INTO servicios (service_id, name, category, rate, min, max, input_type, price_type, is_available) 
        VALUES (:service_id, :name, :category, :rate, :min, :max, 'link', 'per_1k', 1)
        ON DUPLICATE KEY UPDATE 
            category = VALUES(category),
            rate = VALUES(rate),
            min = IFNULL(min, VALUES(min)),
            max = IFNULL(max, VALUES(max)),
            input_type = IFNULL(input_type, 'link'),
            price_type = IFNULL(price_type, 'per_1k'),
            is_available = 1
    ");

    $actualizados = 0;
    foreach ($services as $srv) {
        if (isset($srv['service'], $srv['name'], $srv['rate'])) {
            
            $precioOriginal = floatval($srv['rate']);
            $precioConGanancia = round($precioOriginal * $porcentajeGanancia, 4);

            $stmt->execute([
                ':service_id' => $srv['service'],
                ':name'       => $srv['name'],
                ':category'   => $srv['category'] ?? 'General',
                ':rate'       => $precioConGanancia,
                ':min'        => $srv['min'] ?? 1,
                ':max'        => $srv['max'] ?? 10000
            ]);
            $actualizados++;
        }
    }

    // Confirmar cambios si todo salió bien
    $pdo->commit();

    echo json_encode([
        'status' => 'success',
        'message' => "Sincronización exitosa. Se actualizaron $actualizados servicios con ganancia aplicada."
    ]);

} catch (Exception $e) {
    // Revertir cambios ante cualquier fallo en la BD
    $pdo->rollBack();
    file_put_contents('sync_error_log.txt', date('Y-m-d H:i:s') . " - Error crítico en BD: " . $e->getMessage() . "\n", FILE_APPEND);
    
    echo json_encode([
        'status' => 'error',
        'message' => 'Error al guardar en la base de datos. Se revirtieron los cambios por seguridad.'
    ]);
}
?>
