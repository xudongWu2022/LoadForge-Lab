param(
    [int]$DurationSeconds = 330,
    [int]$IntervalSeconds = 5,
    [string]$OutputPath = "reports/seckill-metrics.csv",
    [string]$KafkaContainer = "sekill-kafka-1",
    [string]$MySqlContainer = "sekill-mysql-1",
    [string]$MySqlPassword = "seckill_dev_password"
)

$parent = Split-Path -Parent $OutputPath
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
"timestamp_utc,kafka_lag,orders" | Set-Content -Encoding utf8 $OutputPath
$deadline = (Get-Date).AddSeconds($DurationSeconds)

while ((Get-Date) -lt $deadline) {
    $group = docker exec $KafkaContainer /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group order-consumer-group 2>$null
    $lag = 0L
    foreach ($line in $group) {
        $fields = $line -split '\s+' | Where-Object { $_ }
        if ($fields.Count -ge 6 -and $fields[1] -eq 'order-topic' -and $fields[5] -match '^\d+$') {
            $lag += [long]$fields[5]
        }
    }
    $orders = docker exec -e "MYSQL_PWD=$MySqlPassword" $MySqlContainer mysql -uroot -D seckill -N -e "SELECT COUNT(*) FROM orders;" 2>$null
    "{0},{1},{2}" -f (Get-Date).ToUniversalTime().ToString('o'), $lag, ($orders | Select-Object -First 1) | Add-Content -Encoding utf8 $OutputPath
    Start-Sleep -Seconds $IntervalSeconds
}
