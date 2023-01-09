package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/s3"
	"github.com/aws/aws-sdk-go/service/secretsmanager"
	"github.com/go-sql-driver/mysql"
	_ "github.com/go-sql-driver/mysql"
	"io"
	"os"
)

type UserInfo struct {
	UserName string `json:"username"`
	Password string `json:"password"`
}

type Book struct {
	Id    int
	Name  string
	Price int
}

//go:embed cert/AmazonRootCA1.pem
var amazonRootCA1 []byte

func connect() (*sql.DB, error) {
	mySession := session.Must(session.NewSession())
	svc := secretsmanager.New(mySession, aws.NewConfig().WithRegion("ap-northeast-1"))
	input := &secretsmanager.GetSecretValueInput{
		SecretId: aws.String(os.Getenv("RDS_SECRET_NAME")),
	}
	result, err := svc.GetSecretValue(input)
	if err != nil {
		return nil, err
	}

	var userInfo UserInfo
	secrets := *result.SecretString
	json.Unmarshal([]byte(secrets), &userInfo)

	// CA証明書の設定
	rootCertPool := x509.NewCertPool()
	if ok := rootCertPool.AppendCertsFromPEM(amazonRootCA1); !ok {
		fmt.Println("[ERROR]", "Fialed to append PEM")
	}
	mysql.RegisterTLSConfig("custom", &tls.Config{
		ClientCAs: rootCertPool,
	})

	// MySQLに接続
	dsn := fmt.Sprintf(
		"%s:%s@tcp(%s:%s)/rds_proxy_go?charset=utf8mb4&parseTime=True&loc=Local&tls=custom",
		userInfo.UserName,
		userInfo.Password,
		os.Getenv("PROXY_ENDPOINT"),
		"3306",
	)

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}

	return db, nil
}

func getSql() (string, error) {
	bucketName := os.Getenv("BUCKET_NAME")
	objectKey := "test.sql"
	sess := session.Must(session.NewSession())
	svc := s3.New(sess)
	obj, err := svc.GetObject(&s3.GetObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		return "", err
	}
	defer obj.Body.Close()
	responseBody, err := io.ReadAll(obj.Body)
	if err != nil {
		return "", err
	}
	return string(responseBody), nil
}

func handleRequest(ctx context.Context, request events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	jsonReq, _ := json.Marshal(request)
	fmt.Println(string(jsonReq))

	db, err := connect()
	if err != nil {
		fmt.Println("[ERROR]", err)
		return events.APIGatewayProxyResponse{Body: "connect Error!", StatusCode: 500}, nil
	}
	defer db.Close()

	sql, err := getSql()
	if err != nil {
		fmt.Println("[ERROR]", err)
		return events.APIGatewayProxyResponse{Body: "Get SQL Error!", StatusCode: 500}, nil
	}

	rows, err := db.Query(sql)
	if err != nil {
		fmt.Println("[ERROR]", err)
		return events.APIGatewayProxyResponse{Body: "Query Error!", StatusCode: 500}, nil
	}
	defer rows.Close()

	var books []Book
	for rows.Next() {
		var book Book
		err := rows.Scan(&book.Id, &book.Name, &book.Price)
		if err != nil {
			fmt.Println("[ERROR]", err)
			return events.APIGatewayProxyResponse{Body: "Scan Error!", StatusCode: 500}, nil
		}
		books = append(books, book)
	}

	jsonBooks, _ := json.Marshal(books)
	return events.APIGatewayProxyResponse{
		Body:       string(jsonBooks),
		StatusCode: 200,
	}, nil
}

func main() {
	lambda.Start(handleRequest)
}
