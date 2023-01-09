import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as go from '@aws-cdk/aws-lambda-go-alpha'
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

interface LambdaStackProps extends cdk.StackProps {
    vpc: ec2.Vpc,
    lambdaToRDSProxyGroup: ec2.SecurityGroup,
    proxy: rds.DatabaseProxy,
    databaseCredentialsSecret: secrets.Secret,
}

export class LambdaStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props: LambdaStackProps) {
        super(scope, id, props);

        // S3
        const bucket = new s3.Bucket(this, 'SQLBucket', {
          bucketName: 'rdsproxy-sql-bucket',
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
        });
        props.vpc.addGatewayEndpoint("S3VpcEndpoint", {
            service: ec2.InterfaceVpcEndpointAwsService.S3,
        });

        // Lambda
        const rdsLambda = new go.GoFunction(this, 'RdsProxyHandler', {
            vpc: props.vpc,
            entry: 'lambda',
            securityGroups: [props.lambdaToRDSProxyGroup],
            environment: {
                PROXY_ENDPOINT: props.proxy.endpoint,
                RDS_SECRET_NAME: props.databaseCredentialsSecret.secretName,
                BUCKET_NAME: bucket.bucketName
            },
            timeout: cdk.Duration.seconds(300)
        });

        // Lambdaにアクセス権限付与
        props.databaseCredentialsSecret.grantRead(rdsLambda);
        bucket.grantRead(rdsLambda);

        // API Gateway
        const restApi = new apigw.RestApi(this, 'RestApi', {
            restApiName: 'rds-proxy-go',
            deployOptions: {
                stageName: 'dev',
            },
        });
        const rdsLambdaIntegration = new apigw.LambdaIntegration(rdsLambda);
        const booksResource = restApi.root.addResource('books');
        booksResource.addMethod('GET', rdsLambdaIntegration);
    }
}
