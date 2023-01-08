import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class CdkRdsProxyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 2,
      natGateways: 0,
      cidr: '10.1.0.0/16',
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // セキュリティグループ(bastion)
    const bastionGroup = new ec2.SecurityGroup(
        this,
        'Bastion to DB Connection',
        {
          vpc,
        }
    );

    // セキュリティグループ(Lambda to RDS Proxy)
    const lambdaToRDSProxyGroup = new ec2.SecurityGroup(
        this,
        'Lambda to RDS Proxy Connection',
        {
          vpc,
        }
    );

    // セキュリティグループ(Proxy to DB)
    const dbConnectionGroup = new ec2.SecurityGroup(
        this,
        'Proxy to DB Connection',
        {
          vpc,
        }
    );
    dbConnectionGroup.addIngressRule(
        dbConnectionGroup,
        ec2.Port.tcp(3306),
        'allow db connection'
    );
    dbConnectionGroup.addIngressRule(
        lambdaToRDSProxyGroup,
        ec2.Port.tcp(3306),
        'allow lambda connection'
    );
    dbConnectionGroup.addIngressRule(
        bastionGroup,
        ec2.Port.tcp(3306),
        'allow bastion connection'
    );

    // Bastionサーバー
    const host = new ec2.BastionHostLinux(this, 'BastionHost', {
      vpc,
      instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T2,
          ec2.InstanceSize.MICRO
      ),
      securityGroup: bastionGroup,
      subnetSelection: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    });
    host.instance.addUserData('yum -y update', 'yum install -y mysql jq');

    // シークレットマネージャー
    const databaseCredentialsSecret = new secrets.Secret(
        this,
        'DBCredentialsSecret',
        {
          secretName: id + '-rds-credentials',
          generateSecretString: {
            secretStringTemplate: JSON.stringify({
              username: 'syscdk',
            }),
            excludePunctuation: true,
            includeSpace: false,
            generateStringKey: 'password',
          },
        }
    );

    // VPCエンドポイント(シークレットマネージャー)
    new ec2.InterfaceVpcEndpoint(this, 'SecretManagerVpcEndpoint', {
      vpc: vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    // RDS
    const rdsInstance = new rds.DatabaseInstance(this, 'DBInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_30,
      }),
      credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
      instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T2,
          ec2.InstanceSize.MICRO
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbConnectionGroup],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deletionProtection: false,
      parameterGroup: new rds.ParameterGroup(this, 'ParameterGroup', {
        engine: rds.DatabaseInstanceEngine.mysql({
          version: rds.MysqlEngineVersion.VER_8_0_30,
        }),
        parameters: {
          character_set_client: 'utf8mb4',
          character_set_server: 'utf8mb4',
        },
      }),
    });

    // RDS Proxy
    const proxy = rdsInstance.addProxy(id + '-proxy', {
      secrets: [databaseCredentialsSecret],
      debugLogging: true,
      vpc,
      securityGroups: [dbConnectionGroup],
    });

    // Lambda
    const rdsLambda = new lambda.Function(this, 'RdsProxyHandler', {
      runtime: lambda.Runtime.GO_1_X,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'main',
      vpc: vpc,
      securityGroups: [lambdaToRDSProxyGroup],
      environment: {
        PROXY_ENDPOINT: proxy.endpoint,
        RDS_SECRET_NAME: id + '-rds-credentials',
      },
    });

    // シークレットマネージャーへのアクセス権限
    databaseCredentialsSecret.grantRead(rdsLambda);
    databaseCredentialsSecret.grantRead(host);

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
